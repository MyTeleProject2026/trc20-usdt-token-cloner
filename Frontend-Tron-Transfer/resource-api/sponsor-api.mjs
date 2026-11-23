import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import pg from 'pg'
import { isIP } from 'node:net'
import { TronWeb } from 'tronweb'
import { createSponsorTransactionEngine } from './sponsor-engine.mjs'
import { normalizePostgresTlsMode } from './scripts/sponsor-ledger-database-identity.mjs'

const { Pool } = pg
const SESSION_TTL_MS = 15 * 60_000
const CHALLENGE_TTL_MS = 5 * 60_000
const INTENT_TTL_MS = 5 * 60_000
const IDEMPOTENCY = /^[A-Za-z0-9._:-]{24,128}$/
const TXID = /^[0-9a-f]{64}$/i
const CONFIRMATION = 'CONFIRM TRON MAINNET SPONSOR TRANSACTION'
const challenges = new Map()
const intents = new Map()
let pool
const schemaPromises = new WeakMap()

function sha(value) { return createHash('sha256').update(value).digest('hex') }
// Render requests pass through Cloudflare. Use its validated client-address
// header for per-client budgets and never trust caller-controlled X-Forwarded-For.
function sponsorClientIp(req) {
  const cloudflareIp = typeof req.headers?.['cf-connecting-ip'] === 'string'
    ? req.headers['cf-connecting-ip'].trim()
    : ''
  if (isIP(cloudflareIp)) return cloudflareIp
  return req.socket?.remoteAddress || 'unknown'
}
function equalText(a, b) {
  const left = Buffer.from(String(a || ''))
  const right = Buffer.from(String(b || ''))
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right)
}
function validAddress(value) {
  if (typeof value !== 'string' || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value)) return false
  let decoded = 0n
  for (const char of value) {
    const digit = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.indexOf(char)
    if (digit < 0) return false
    decoded = decoded * 58n + BigInt(digit)
  }
  let hex = decoded.toString(16)
  if (hex.length % 2) hex = '0' + hex
  const payload = Buffer.from(hex, 'hex')
  if (payload.length !== 25 || payload[0] !== 0x41) return false
  const body = payload.subarray(0, 21)
  const checksum = createHash('sha256').update(createHash('sha256').update(body).digest()).digest().subarray(0, 4)
  return checksum.equals(payload.subarray(21))
}
function positiveSun(value) {
  return typeof value === 'string' && /^[1-9][0-9]{0,20}$/.test(value) && BigInt(value) <= (1n << 63n) - 1n
}
function cleanup(now = Date.now()) {
  for (const [key, value] of challenges) if (value.expiresAt <= now) challenges.delete(key)
  for (const [key, value] of intents) if (value.expiresAt <= now) intents.delete(key)
  while (challenges.size > 5000) challenges.delete(challenges.keys().next().value)
  while (intents.size > 5000) intents.delete(intents.keys().next().value)
}
async function readBody(req, maxBytes = 16_384) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw Object.assign(new Error('request-body-too-large'), { status: 413 })
    chunks.push(chunk)
  }
  if (!size) return {}
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-json-object')
    return value
  } catch { throw Object.assign(new Error('invalid-json'), { status: 400 }) }
}
const SPONSOR_DATABASE_URL_KEYS = [
  'SPONSOR_DATABASE_URL_POOLED',
  'SPONSOR_DATABASE_URL',
  'DATABASE_URL_POOLED',
  'DATABASE_URL',
]

export function sponsorDatabaseConnectionInfo(env = process.env) {
  const sourceVariable = SPONSOR_DATABASE_URL_KEYS.find(key =>
    typeof env[key] === 'string' && env[key].trim().length > 0
  ) || null
  if (!sourceVariable) {
    return { configured: false, sourceVariable: null, provider: 'not-configured', connectionMode: 'unknown' }
  }

  const connectionString = env[sourceVariable].trim()
  let hostname = ''
  let identityFingerprint = null
  try {
    const parsed = new URL(connectionString)
    hostname = parsed.hostname.toLowerCase()
    // A one-way fingerprint proves which database endpoint/name/role is selected
    // without returning a hostname or credential in production diagnostics.
    const identity = JSON.stringify({
      hostname,
      port: parsed.port || '5432',
      database: decodeURIComponent(parsed.pathname.slice(1)),
      username: decodeURIComponent(parsed.username),
    })
    identityFingerprint = sha(identity)
  } catch {
    return {
      configured: true,
      sourceVariable,
      provider: 'unrecognized',
      connectionMode: sourceVariable.endsWith('_POOLED') ? 'pooled' : 'direct',
      identityFingerprint: null,
    }
  }

  const provider = hostname.endsWith('.neon.tech')
    ? 'neon'
    : hostname.endsWith('.render.com') || hostname.includes('render')
      ? 'render-postgres'
      : 'external-postgres'
  return {
    configured: true,
    sourceVariable,
    provider,
    connectionMode: sourceVariable.endsWith('_POOLED') ? 'pooled' : 'direct',
    identityFingerprint,
  }
}

export function sponsorDatabaseConnectionString(env = process.env) {
  const info = sponsorDatabaseConnectionInfo(env)
  return info.configured ? env[info.sourceVariable] : null
}

export function sponsorDatabaseTargetIdentityInfo(env = process.env) {
  // Sponsor runtime queries may use the Neon pooler; migrations and deployment
  // ledgers use the direct endpoint. Fingerprint the approved logical target.
  const direct = typeof env.OWNER_ADMIN_DATABASE_URL === 'string' ? env.OWNER_ADMIN_DATABASE_URL.trim() : ''
  if (!direct) return sponsorDatabaseConnectionInfo(env)
  try {
    const parsed = new URL(direct)
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname || parsed.pathname === '/') throw new Error('invalid-url')
    const identity = JSON.stringify({
      hostname: parsed.hostname.toLowerCase(),
      port: parsed.port || '5432',
      database: decodeURIComponent(parsed.pathname.slice(1)),
      username: decodeURIComponent(parsed.username),
    })
    const hostname = parsed.hostname.toLowerCase()
    return {
      configured: true,
      sourceVariable: 'OWNER_ADMIN_DATABASE_URL',
      provider: hostname.endsWith('.neon.tech') ? 'neon' : hostname.endsWith('.render.com') || hostname.includes('render') ? 'render-postgres' : 'external-postgres',
      connectionMode: 'direct',
      identityFingerprint: sha(identity),
    }
  } catch {
    return { configured: true, sourceVariable: 'OWNER_ADMIN_DATABASE_URL', provider: 'unrecognized', connectionMode: 'direct', identityFingerprint: null }
  }
}

function getPool(env) {
  const connectionString = sponsorDatabaseConnectionString(env)
  if (!connectionString) return null
  if (!pool) {
    pool = new Pool({ connectionString: normalizePostgresTlsMode(connectionString), connectionTimeoutMillis: 2500, query_timeout: 2500, statement_timeout: 2000, idleTimeoutMillis: 30_000, max: 3 })
    pool.on('error', error => process.stderr.write('Sponsor ledger database error: ' + String(error?.code || 'unknown') + '\n'))
  }
  return pool
}
async function ensureSchema(db) {
  let pending = schemaPromises.get(db)
  if (!pending) {
    pending = db.query(`
      CREATE TABLE IF NOT EXISTS public.tron_transfer_sponsor_operations (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        idempotency_key_hash CHAR(64) NOT NULL UNIQUE,
        request_hash CHAR(64) NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('stake','delegate','undelegate','unstake','withdraw','topup')),
        resource TEXT NOT NULL CHECK (resource IN ('ENERGY','BANDWIDTH','TRX')),
        amount_sun NUMERIC(21,0) NOT NULL CHECK (amount_sun > 0),
        sponsor_address TEXT NOT NULL,
        owner_address TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('reserved','signed-not-broadcast','broadcast-unknown','confirmed','failed')),
        transaction_id CHAR(64),
        prepared_transaction JSONB,
        signed_transaction JSONB,
        result_code TEXT,
        confirmation_block BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE public.tron_transfer_sponsor_operations ADD COLUMN IF NOT EXISTS prepared_transaction JSONB;
      ALTER TABLE public.tron_transfer_sponsor_operations ADD COLUMN IF NOT EXISTS signed_transaction JSONB;
      ALTER TABLE public.tron_transfer_sponsor_operations DROP CONSTRAINT IF EXISTS tron_transfer_sponsor_operations_operation_check;
      ALTER TABLE public.tron_transfer_sponsor_operations ADD CONSTRAINT tron_transfer_sponsor_operations_operation_check CHECK (operation IN ('stake','delegate','undelegate','unstake','withdraw','topup'));
      ALTER TABLE public.tron_transfer_sponsor_operations DROP CONSTRAINT IF EXISTS tron_transfer_sponsor_operations_resource_check;
      ALTER TABLE public.tron_transfer_sponsor_operations ADD CONSTRAINT tron_transfer_sponsor_operations_resource_check CHECK (resource IN ('ENERGY','BANDWIDTH','TRX'));
      CREATE INDEX IF NOT EXISTS tron_transfer_sponsor_operations_sponsor_created
        ON public.tron_transfer_sponsor_operations (sponsor_address, created_at DESC);
      CREATE TABLE IF NOT EXISTS public.tron_transfer_sponsor_control (
        id SMALLINT PRIMARY KEY CHECK (id = 1),
        writes_paused BOOLEAN NOT NULL DEFAULT TRUE,
        pause_reason TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO public.tron_transfer_sponsor_control (id, writes_paused, pause_reason)
        VALUES (1, TRUE, 'schema-bootstrap-requires-explicit-cutover') ON CONFLICT (id) DO NOTHING;
    `).catch(error => { schemaPromises.delete(db); throw error })
    schemaPromises.set(db, pending)
  }
  await pending
}

// Runtime reads and transaction execution must never create or alter production
// schema. Schema creation is reserved for the separately authorized bootstrap
// endpoint; all other routes fail closed until that bootstrap has completed.
async function assertSchema(db) {
  const schema = await db.query(`
    SELECT
      to_regclass('public.tron_transfer_sponsor_operations') AS operations_table,
      to_regclass('public.tron_transfer_sponsor_control') AS control_table,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tron_transfer_sponsor_operations' AND column_name='prepared_transaction') AS prepared_transaction_column,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tron_transfer_sponsor_operations' AND column_name='signed_transaction') AS signed_transaction_column
  `)
  if (!schema.rows?.[0]?.operations_table || !schema.rows?.[0]?.control_table
    || schema.rows[0].prepared_transaction_column !== true || schema.rows[0].signed_transaction_column !== true) {
    throw new Error('sponsor-ledger-schema-not-initialized')
  }
  const control = await db.query(
    'SELECT writes_paused FROM public.tron_transfer_sponsor_control WHERE id=1'
  )
  if (!control.rows?.length) throw new Error('sponsor-ledger-control-row-missing')
  return { writesPaused: control.rows[0].writes_paused === true }
}

async function readSponsorWritesPaused(db) {
  const result = await db.query('SELECT writes_paused FROM public.tron_transfer_sponsor_control WHERE id=1')
  return result.rows?.[0]?.writes_paused === true
}

function sessionSecret(env) {
  return typeof env.SPONSOR_SESSION_SECRET === 'string' && Buffer.byteLength(env.SPONSOR_SESSION_SECRET) >= 32
    ? env.SPONSOR_SESSION_SECRET : null
}
function adminTokenRequired() {
  // Sponsor writes always require the independent Owner Admin second factor.
  // Missing configuration must fail closed, not silently disable the factor.
  return true
}
function verifyAdminToken(req, env) {
  const expected = env.SPONSOR_ADMIN_TOKEN
  return typeof expected === 'string' && expected.length >= 32
    && equalText(req.headers?.['x-sponsor-admin-token'], expected)
}

function sponsorLedgerDurabilityVerified(env) {
  return env.SPONSOR_LEDGER_DURABLE === 'true'
    && env.SPONSOR_LEDGER_BACKUP_VERIFIED === 'true'
    && env.SPONSOR_LEDGER_RESTORE_TESTED === 'true'
}
function issueSession(address, env, now = Date.now()) {
  const secret = sessionSecret(env)
  if (!secret) throw new Error('sponsor-session-secret-not-configured')
  const payload = Buffer.from(JSON.stringify({ address, network: 'mainnet', exp: now + SESSION_TTL_MS })).toString('base64url')
  const signature = createHmac('sha256', secret).update(payload).digest('base64url')
  return payload + '.' + signature
}
function verifySession(req, env, now = Date.now()) {
  const secret = sessionSecret(env)
  if (!secret) return null
  const authorization = String(req.headers?.authorization || '')
  const match = authorization.match(/^Bearer ([A-Za-z0-9_.-]{30,2048})$/)
  if (!match) return null
  const [payload, signature] = match[1].split('.')
  if (!payload || !signature) return null
  const expected = createHmac('sha256', secret).update(payload).digest('base64url')
  if (!equalText(signature, expected)) return null
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (value.network !== 'mainnet' || value.exp <= now || value.address !== env.SPONSOR_MAINNET_ADDRESS) return null
    return value
  } catch { return null }
}
function challengeMessage({ address, nonce, expiresAt }) {
  return [
    'TRON TRANSFER SPONSOR WALLET SESSION',
    'Network: TRON Mainnet',
    'Address: ' + address,
    'Nonce: ' + nonce,
    'Expires: ' + new Date(expiresAt).toISOString(),
    'Purpose: authenticate this Sponsor Wallet session only; this message is not a transaction.',
  ].join('\n')
}
function intentMessage(value) {
  return [
    'TRON TRANSFER SPONSOR TRANSACTION AUTHORIZATION',
    'Network: TRON Mainnet',
    'Sponsor: ' + value.sponsorAddress,
    'Owner recipient: ' + value.ownerAddress,
    'Operation: ' + value.operation,
    'Resource: ' + value.resource,
    'Amount (sun): ' + value.amountSun,
    'Idempotency key: ' + value.idempotencyKey,
    'Expires: ' + new Date(value.expiresAt).toISOString(),
    'This message authorizes only the exact Sponsor operation above. It is not a TRON transaction.',
  ].join('\n')
}

function classifySponsorDatabaseError(error) {
  const code = String(error?.code || '')
  if (code === 'ECONNREFUSED') return 'connection-refused'
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'connection-timeout'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'database-host-unresolved'
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'database-host-unreachable'
  if (code === 'ECONNRESET') return 'connection-reset'
  if (code === '28P01' || code === '28000') return 'authentication-failed'
  if (code === '3D000') return 'database-not-found'
  if (code === '42501') return 'permission-denied'
  if (code === '57P03') return 'database-unavailable'
  if (code.startsWith('08')) return 'connection-failed'
  return 'query-failed'
}

export function createSponsorResourceApi({
  env = process.env,
  allowedAddress = env.TRON_OWNER_ADDRESS || env.TRON_OWNER_WALLET_ADDRESS || 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp',
  fetchImpl = globalThis.fetch,
  signerAdapter = null,
  engine = createSponsorTransactionEngine({ env, fetchImpl, ...(signerAdapter ? { signerAdapter } : {}) }),
  getDatabase = () => getPool(env),
  authenticateManagedSession = null,
  authenticateOwnerAdminSession = null,
  verifyMessage = async (message, signature) => {
    const verifier = new TronWeb({ fullHost: 'https://api.trongrid.io' })
    return verifier.trx.verifyMessageV2(message, signature)
  },
  send,
  now = () => Date.now(),
} = {}) {
  if (typeof send !== 'function') throw new TypeError('send response helper is required')
  const ownerAddress = allowedAddress
  const ownerAdminAuthConfigured = typeof authenticateOwnerAdminSession === 'function'
  async function verifyAdminAuthorization(req) {
    if (ownerAdminAuthConfigured) {
      const session = await authenticateOwnerAdminSession(req, { requireCsrf: true })
      return Boolean(session && session.address === ownerAddress)
    }
    return verifyAdminToken(req, env)
  }
  const rateCounts = new Map()
  function rateLimit(req, key, max = 12) {
    const ip = String(sponsorClientIp(req)).slice(0, 80)
    const bucket = key + ':' + ip
    const timestamp = now()
    const previous = rateCounts.get(bucket)
    if (previous && timestamp - previous.startedAt < 60_000) {
      previous.count += 1
      return previous.count <= max
    }
    if (rateCounts.size >= 2000) {
      for (const [id, item] of rateCounts) if (timestamp - item.startedAt >= 60_000) rateCounts.delete(id)
      if (rateCounts.size >= 2000) return false
    }
    rateCounts.set(bucket, { startedAt: timestamp, count: 1 })
    return true
  }
  const reply = (res, status, value, origin) => { send(res, status, value, origin); return true }
  const localSponsorSigningImplemented = () => typeof engine.prepare === 'function' && typeof engine.submitSigned === 'function'

  let sponsorStatusCache = { at: 0, value: null }
  let sponsorStatusInFlight = null
  const buildStatusPayload = async () => {
        const readiness = engine.readiness()
        // The engine exposes the client-local signing protocol. This is a code-capability
        // check only; wallet unlock, Mainnet flags, ledger acceptance and pause state
        // remain independent gates.
        const localSignerReady = localSponsorSigningImplemented()
        const databaseConnection = sponsorDatabaseConnectionInfo(env)
        const dbConfigured = databaseConnection.configured
        const expectedDatabaseIdentity = typeof env.OWNER_ADMIN_EXPECTED_DATABASE_IDENTITY_SHA256 === 'string'
          ? env.OWNER_ADMIN_EXPECTED_DATABASE_IDENTITY_SHA256.trim().toLowerCase()
          : ''
        const expectedDatabaseIdentityValid = /^[0-9a-f]{64}$/.test(expectedDatabaseIdentity)
        const databaseTargetIdentity = sponsorDatabaseTargetIdentityInfo(env)
        const databaseIdentityMatches = expectedDatabaseIdentityValid
          && databaseTargetIdentity.identityFingerprint === expectedDatabaseIdentity
        const ownerAddressMatches = validAddress(ownerAddress) && readiness.ownerAddress === ownerAddress
        const sponsorIndependent = validAddress(env.SPONSOR_MAINNET_ADDRESS) && env.SPONSOR_MAINNET_ADDRESS !== ownerAddress
        const adminRequired = true
        const adminConfigured = ownerAdminAuthConfigured || (typeof env.SPONSOR_ADMIN_TOKEN === 'string' && env.SPONSOR_ADMIN_TOKEN.length >= 32)
        const ledgerDurabilityVerified = sponsorLedgerDurabilityVerified(env)
        let databaseReady = false
        let databaseStatus = dbConfigured ? 'unchecked' : 'not-configured'
        // Unknown or unreadable write-control state must always be treated as paused.
        let sponsorWritesPaused = true
        if (dbConfigured) {
          try {
            const db = getDatabase()
            if (!db) {
              databaseStatus = 'pool-unavailable'
            } else {
              // Status checks must never create or migrate production tables.
              // Confirm the expected schema and control row using read-only queries.
              const schema = await db.query(`
                SELECT
                  to_regclass('public.tron_transfer_sponsor_operations') AS operations_table,
                  to_regclass('public.tron_transfer_sponsor_control') AS control_table,
                  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tron_transfer_sponsor_operations' AND column_name='prepared_transaction') AS prepared_transaction_column,
                  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tron_transfer_sponsor_operations' AND column_name='signed_transaction') AS signed_transaction_column
              `)
              if (!schema.rows?.[0]?.operations_table || !schema.rows?.[0]?.control_table
                || schema.rows[0].prepared_transaction_column !== true || schema.rows[0].signed_transaction_column !== true) {
                databaseStatus = 'schema-missing'
              } else {
                const control = await db.query('SELECT writes_paused FROM public.tron_transfer_sponsor_control WHERE id=1')
                if (!control.rows?.length) {
                  databaseStatus = 'control-row-missing'
                } else {
                  sponsorWritesPaused = control.rows[0].writes_paused === true
                  databaseReady = true
                  databaseStatus = 'ready'
                }
              }
            }
          } catch (error) { databaseStatus = classifySponsorDatabaseError(error) }
        }
        const acceptanceChecks = [
          { id: 'owner-address', state: ownerAddressMatches ? 'passed' : 'blocked' },
          { id: 'sponsor-address-format-and-separation', state: sponsorIndependent ? 'passed' : 'blocked' },
          { id: 'sponsor-mainnet-address-configured-and-independent', state: readiness.sponsorAddressValid === true && sponsorIndependent ? 'passed' : 'blocked' },
          { id: 'ledger-database-configured', state: dbConfigured ? 'passed' : 'blocked' },
          { id: 'database-target-identity', state: databaseIdentityMatches ? 'passed' : 'blocked' },
          { id: 'ledger-schema-and-control-row', state: databaseReady ? 'passed' : 'blocked', detail: databaseStatus },
          { id: 'ledger-durability-and-restore-attestation', state: ledgerDurabilityVerified ? 'passed' : 'blocked' },
          { id: 'writes-remain-paused-until-release', state: sponsorWritesPaused ? 'passed' : 'blocked' },
          { id: 'owner-admin-second-factor-configured', state: adminConfigured ? 'passed' : 'blocked' },
          { id: 'session-authentication-configured', state: sessionSecret(env) ? 'passed' : 'blocked' },
          { id: 'sponsor-local-transaction-signer', state: localSignerReady ? 'passed' : 'blocked' },
          { id: 'mainnet-execution-explicitly-disabled', state: readiness.enabled !== true ? 'passed' : 'review-required' },
        ]
        const acceptancePassed = acceptanceChecks.every(check => check.state === 'passed')
        const acceptance = {
          version: 1,
          state: acceptancePassed ? 'ready-for-independent-review' : 'blocked',
          executionEnabled: false,
          checks: acceptanceChecks,
          note: 'Read-only diagnostic. Passing checks do not authorize Mainnet execution; operator approval and independent acceptance remain required.',
        }
        return {
          success: true,
          acceptance,
          network: 'TRON Mainnet',
          ownerAddress,
          sponsorAddress: validAddress(env.SPONSOR_MAINNET_ADDRESS) ? env.SPONSOR_MAINNET_ADDRESS : null,
          sessionAuthenticationConfigured: Boolean(sessionSecret(env)),
          databaseConfigured: dbConfigured,
          databaseConnection,
          databaseIdentityMatches,
          expectedDatabaseIdentityConfigured: expectedDatabaseIdentityValid,
          databaseReady,
          databaseStatus,
          sponsorWritesPaused,
          ledgerDurabilityVerified,
          ownerAddressMatches,
          sponsorIndependent,
          engineConfigured: readiness.configured === true,
          engineEnabled: readiness.enabled === true,
          localSignerReady,
          transactionExecutionAvailable: localSignerReady && readiness.clientSigningAvailable === true && databaseReady && !sponsorWritesPaused && Boolean(sessionSecret(env)) && ownerAddressMatches && sponsorIndependent && adminConfigured && ledgerDurabilityVerified,
          feePolicy: readiness.feePolicy,
          stakingPolicy: readiness.stakingPolicy,
          ownerTopupPolicy: readiness.ownerTopupPolicy,
          adminTokenRequired: adminRequired,
          adminTokenConfigured: adminConfigured,
          checkedAt: new Date(now()).toISOString(),
        }
  }

  async function handle(req, res, url, origin) {
    const path = url.pathname
    const isRoute = path === '/api/sponsor/status'
      || path === '/api/acceptance/production'
      || path === '/api/sponsor/ledger/bootstrap'
      || path === '/api/sponsor/session/challenge'
      || path === '/api/sponsor/session/verify'
      || path === '/api/sponsor/intent'
      || path === '/api/sponsor/operations'
      || path === '/api/sponsor/operations/prepare'
      || path === '/api/sponsor/operations/submit'
      || /^\/api\/sponsor\/operations\/[A-Za-z0-9._:-]+$/.test(path)
      || path === '/api/tron/sponsorship/resource-delegations'
      || path === '/api/tron/sponsorship/resource-delegations/verify-wallet'
    if (!isRoute) return false
    cleanup(now())

    if (req.method === 'GET' && (path === '/api/sponsor/status' || path === '/api/acceptance/production')) {
      if (sponsorStatusCache.value?.sponsorWritesPaused === true && now() - sponsorStatusCache.at < 5000) {
        return reply(res, 200, sponsorStatusCache.value, origin)
      }
      let pending = sponsorStatusInFlight
      if (!pending) {
        pending = buildStatusPayload()
        sponsorStatusInFlight = pending
      }
      try {
        const payload = await pending
        sponsorStatusCache = payload.sponsorWritesPaused === true ? { at: now(), value: payload } : { at: 0, value: null }
        return reply(res, 200, payload, origin)
      } catch {
        return reply(res, 503, {
          success: false, error: 'SPONSOR_STATUS_UNAVAILABLE',
          sponsorWritesPaused: true, transactionExecutionAvailable: false,
          message: 'Sponsor status could not be read from the configured database. Writes remain paused.',
        }, origin)
      } finally {
        if (sponsorStatusInFlight === pending) sponsorStatusInFlight = null
      }
    }

    if (req.method === 'POST' && path === '/api/sponsor/ledger/bootstrap') {
      if (!(await verifyAdminAuthorization(req))) return reply(res, 401, { success: false, error: 'admin-authorization-required' }, origin)
      let bootstrapInput
      try { bootstrapInput = await readBody(req) } catch (error) {
        return reply(res, Number(error?.status) || 400, { success: false, error: 'invalid-bootstrap-request' }, origin)
      }
      if (bootstrapInput.confirm !== 'INITIALIZE_SPONSOR_LEDGER_SCHEMA') {
        return reply(res, 400, { success: false, error: 'explicit-ledger-bootstrap-confirmation-required' }, origin)
      }
      if (!sponsorDatabaseConnectionInfo(env).configured) {
        return reply(res, 503, { success: false, error: 'sponsor-ledger-database-not-configured' }, origin)
      }
      const db = getDatabase()
      if (!db) return reply(res, 503, { success: false, error: 'sponsor-ledger-database-unavailable' }, origin)
      try {
        // Idempotently create only the ledger schema. This never imports source
        // rows, changes an existing pause state, or authorizes a transaction.
        await ensureSchema(db)
        const control = await db.query('SELECT writes_paused FROM public.tron_transfer_sponsor_control WHERE id=1')
        if (!control.rows?.length) {
          return reply(res, 503, { success: false, error: 'sponsor-ledger-control-row-missing', sponsorWritesPaused: true }, origin)
        }
        const sponsorWritesPaused = control.rows[0].writes_paused === true
        return reply(res, sponsorWritesPaused ? 200 : 409, {
          success: sponsorWritesPaused,
          schemaInitialized: true,
          databaseReady: sponsorWritesPaused,
          sponsorWritesPaused,
          transactionExecutionAvailable: false,
          message: sponsorWritesPaused
            ? 'Ledger schema initialized; source reconciliation, durability verification, and explicit cutover remain required.'
            : 'Ledger schema exists but writes are not paused. No pause state was changed; pause writes before migration.',
        }, origin)
      } catch (error) {
        return reply(res, 503, { success: false, error: classifySponsorDatabaseError(error), sponsorWritesPaused: true }, origin)
      }
    }

    if (req.method === 'POST' && path === '/api/sponsor/session/challenge') {
      if (!rateLimit(req, 'session-challenge', 8)) return reply(res, 429, { success: false, error: 'rate-limited' }, origin)
      let body
      try { body = await readBody(req) } catch (error) { return reply(res, error.status || 400, { success: false, error: error.message }, origin) }
      const address = body.address
      if (!validAddress(address) || address !== env.SPONSOR_MAINNET_ADDRESS || address === ownerAddress) {
        return reply(res, 403, { success: false, error: 'sponsor-wallet-not-authorized' }, origin)
      }
      if (!sessionSecret(env)) return reply(res, 503, { success: false, error: 'sponsor-session-authentication-not-configured' }, origin)
      const nonce = randomBytes(24).toString('base64url')
      const expiresAt = now() + CHALLENGE_TTL_MS
      const message = challengeMessage({ address, nonce, expiresAt })
      challenges.set(nonce, { address, message, expiresAt })
      return reply(res, 201, { success: true, address, network: 'TRON Mainnet', nonce, message, expiresAt: new Date(expiresAt).toISOString() }, origin)
    }

    if (req.method === 'POST' && path === '/api/sponsor/session/verify') {
      if (!rateLimit(req, 'session-verify', 8)) return reply(res, 429, { success: false, error: 'rate-limited' }, origin)
      let body
      try { body = await readBody(req) } catch (error) { return reply(res, error.status || 400, { success: false, error: error.message }, origin) }
      const challenge = challenges.get(body.nonce)
      if (!challenge || challenge.expiresAt <= now() || challenge.address !== body.address) return reply(res, 401, { success: false, error: 'challenge-expired-or-invalid' }, origin)
      challenges.delete(body.nonce)
      if (typeof body.signature !== 'string' || !/^(?:0x)?[0-9a-f]{130}$/i.test(body.signature)) return reply(res, 400, { success: false, error: 'invalid-message-signature' }, origin)
      try {
        const recovered = await verifyMessage(challenge.message, body.signature)
        if (recovered !== challenge.address) return reply(res, 401, { success: false, error: 'sponsor-signature-address-mismatch' }, origin)
        const token = issueSession(challenge.address, env, now())
        return reply(res, 200, { success: true, network: 'TRON Mainnet', address: challenge.address, token, expiresAt: new Date(now() + SESSION_TTL_MS).toISOString() }, origin)
      } catch {
        return reply(res, 401, { success: false, error: 'sponsor-signature-verification-failed' }, origin)
      }
    }

    if (req.method === 'GET' && path === '/api/tron/sponsorship/resource-delegations') {
      const address = url.searchParams.get('address')
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 100)))
      if (url.searchParams.get('network') !== 'mainnet' || !validAddress(address) || address !== env.SPONSOR_MAINNET_ADDRESS) {
        return reply(res, 403, { success: false, error: 'sponsor-address-not-allowed' }, origin)
      }
      const db = getDatabase()
      if (!db) return reply(res, 503, { success: false, error: 'sponsor-ledger-unavailable' }, origin)
      try {
        await assertSchema(db)
        const result = await db.query(
          'SELECT transaction_id AS "transactionId",sponsor_address AS "sponsorAddress",owner_address AS "receiverAddress",resource AS "resourceType",amount_sun::text AS "stakeEquivalentSun",status,confirmation_block AS "blockNumber",created_at AS "recordedAt" FROM public.tron_transfer_sponsor_operations WHERE sponsor_address=$1 AND operation=\'delegate\' AND status=\'confirmed\' ORDER BY created_at DESC LIMIT $2',
          [address, limit],
        )
        return reply(res, 200, { success: true, network: 'TRON Mainnet', delegations: result.rows || [] }, origin)
      } catch { return reply(res, 503, { success: false, error: 'sponsor-ledger-read-failed' }, origin) }
    }

    const managedSessionAuth = typeof authenticateManagedSession === 'function'
    const session = managedSessionAuth
      ? await authenticateManagedSession(req, { requireCsrf: req.method !== 'GET' })
      : verifySession(req, env, now())
    if (!session) return reply(res, 401, { success: false, error: 'sponsor-session-required' }, origin)
    // A managed Sponsor session is bound to the address enrolled at that time.
    // Re-check it against the currently configured Mainnet Sponsor identity on
    // every request so an environment rotation cannot leave a stale signer active.
    if (session.address !== env.SPONSOR_MAINNET_ADDRESS || session.address === ownerAddress) {
      return reply(res, 403, { success: false, error: 'sponsor-session-address-mismatch' }, origin)
    }

    if (req.method === 'POST' && path === '/api/sponsor/intent') {
      if (!(await verifyAdminAuthorization(req))) return reply(res, 403, { success: false, error: 'sponsor-admin-authorization-required' }, origin)
      if (!sponsorLedgerDurabilityVerified(env)) return reply(res, 503, { success: false, error: 'sponsor-ledger-durability-not-verified' }, origin)
      if (!rateLimit(req, 'intent', 10)) return reply(res, 429, { success: false, error: 'rate-limited' }, origin)
      let body
      try { body = await readBody(req) } catch (error) { return reply(res, error.status || 400, { success: false, error: error.message }, origin) }
      const { operation, resource, amountSun, idempotencyKey } = body
      const validOperation = ['stake', 'delegate', 'undelegate', 'unstake', 'withdraw', 'topup'].includes(operation)
      const validResource = ['topup', 'withdraw'].includes(operation) ? resource === 'TRX' : ['ENERGY', 'BANDWIDTH'].includes(resource)
      if (!validOperation || !validResource
        || !positiveSun(amountSun) || !IDEMPOTENCY.test(String(idempotencyKey || ''))) {
        return reply(res, 400, { success: false, error: 'invalid-sponsor-operation-intent' }, origin)
      }
      const expiresAt = now() + INTENT_TTL_MS
      const intent = { intentId: randomBytes(24).toString('base64url'), sponsorAddress: session.address, ownerAddress, operation, resource, amountSun, idempotencyKey, expiresAt }
      const message = intentMessage(intent)
      intents.set(intent.intentId, { ...intent, message })
      return reply(res, 201, { success: true, intentId: intent.intentId, message, expiresAt: new Date(expiresAt).toISOString(), confirmationPhrase: CONFIRMATION }, origin)
    }


    if (req.method === 'POST' && path === '/api/sponsor/operations/prepare') {
      if (!(await verifyAdminAuthorization(req))) return reply(res, 403, { success: false, error: 'sponsor-admin-authorization-required' }, origin)
      if (!sponsorLedgerDurabilityVerified(env)) return reply(res, 503, { success: false, error: 'sponsor-ledger-durability-not-verified' }, origin)
      if (!localSponsorSigningImplemented() || typeof engine.prepare !== 'function') return reply(res, 423, { success: false, error: 'sponsor-local-signer-not-implemented' }, origin)
      if (!rateLimit(req, 'prepare', 5)) return reply(res, 429, { success: false, error: 'rate-limited' }, origin)
      let body
      try { body = await readBody(req) } catch (error) { return reply(res, error.status || 400, { success: false, error: error.message }, origin) }
      const intent = intents.get(body.intentId)
      if (!intent || intent.expiresAt <= now() || intent.sponsorAddress !== session.address) return reply(res, 409, { success: false, error: 'intent-expired-or-already-used', retryAllowed: false }, origin)
      if (body.confirmPhrase !== CONFIRMATION) return reply(res, 400, { success: false, error: 'explicit-operation-confirmation-required' }, origin)
      intents.delete(body.intentId)
      const db = getDatabase()
      if (!db) return reply(res, 503, { success: false, error: 'durable-idempotency-storage-required' }, origin)
      const keyHash = sha(intent.idempotencyKey)
      const requestHash = sha(JSON.stringify({ operation: intent.operation, resource: intent.resource, amountSun: intent.amountSun, sponsorAddress: session.address, ownerAddress }))
      let client
      let open = false
      try {
        await assertSchema(db)
        client = typeof db.connect === 'function' ? await db.connect() : db
        await client.query('BEGIN')
        open = true
        const pause = await client.query('SELECT writes_paused FROM public.tron_transfer_sponsor_control WHERE id=1 FOR SHARE')
        if (pause.rows?.[0]?.writes_paused !== false) {
          await client.query('ROLLBACK'); open = false
          return reply(res, 423, { success: false, error: 'sponsor-writes-paused-for-maintenance', retryAllowed: false }, origin)
        }
        const reserved = await client.query(
          "INSERT INTO public.tron_transfer_sponsor_operations (idempotency_key_hash,request_hash,operation,resource,amount_sun,sponsor_address,owner_address,status) VALUES ($1,$2,$3,$4,$5,$6,$7,'reserved') ON CONFLICT (idempotency_key_hash) DO NOTHING RETURNING id",
          [keyHash, requestHash, intent.operation, intent.resource, intent.amountSun, session.address, ownerAddress],
        )
        if (!reserved.rowCount) {
          await client.query('ROLLBACK'); open = false
          return reply(res, 409, { success: false, error: 'operation-already-recorded', retryAllowed: false }, origin)
        }
        const prepared = await engine.prepare({ operation: intent.operation, resource: intent.resource, amountSun: intent.amountSun, ownerAddress })
        if (!prepared?.success || !prepared.transaction?.txID) {
          await client.query('ROLLBACK'); open = false
          return reply(res, 422, { success: false, error: prepared?.status || 'sponsor-transaction-preparation-failed', retryAllowed: false }, origin)
        }
        const saved = await client.query(
          "UPDATE public.tron_transfer_sponsor_operations SET prepared_transaction=$2::jsonb,updated_at=now() WHERE idempotency_key_hash=$1 AND status='reserved' RETURNING id",
          [keyHash, JSON.stringify(prepared.transaction)],
        )
        if (!saved.rowCount) throw new Error('prepared-transaction-persistence-failed')
        await client.query('COMMIT'); open = false
        if (client !== db) { client.release(); client = null }
        return reply(res, 201, {
          success: true, operationReference: intent.idempotencyKey, operation: intent.operation,
          resource: intent.resource, amountSun: intent.amountSun, sponsorAddress: session.address,
          ownerAddress, unsignedTransaction: prepared.transaction, feePolicy: prepared.feePolicy,
          expiresAt: new Date(Number(prepared.transaction.raw_data.expiration)).toISOString(),
          note: 'Unsigned Mainnet transaction only. Sign locally in the imported Sponsor vault; do not alter transaction bytes.',
        }, origin)
      } catch {
        if (client && open) await client.query('ROLLBACK').catch(() => {})
        return reply(res, 503, { success: false, error: 'sponsor-transaction-preparation-storage-failed', retryAllowed: false }, origin)
      } finally { if (client && client !== db) client.release() }
    }

    if (req.method === 'POST' && path === '/api/sponsor/operations/submit') {
      if (!(await verifyAdminAuthorization(req))) return reply(res, 403, { success: false, error: 'sponsor-admin-authorization-required' }, origin)
      if (!sponsorLedgerDurabilityVerified(env)) return reply(res, 503, { success: false, error: 'sponsor-ledger-durability-not-verified' }, origin)
      if (!localSponsorSigningImplemented() || typeof engine.submitSigned !== 'function') return reply(res, 423, { success: false, error: 'sponsor-local-signer-not-implemented' }, origin)
      if (!rateLimit(req, 'submit', 3)) return reply(res, 429, { success: false, error: 'rate-limited' }, origin)
      let body
      try { body = await readBody(req, 64_000) } catch (error) { return reply(res, error.status || 400, { success: false, error: error.message }, origin) }
      if (!IDEMPOTENCY.test(String(body.operationReference || '')) || !body.signedTransaction || typeof body.signedTransaction !== 'object') {
        return reply(res, 400, { success: false, error: 'invalid-signed-sponsor-transaction' }, origin)
      }
      const db = getDatabase()
      if (!db) return reply(res, 503, { success: false, error: 'durable-idempotency-storage-required' }, origin)
      const keyHash = sha(body.operationReference)
      let client
      let open = false
      try {
        await assertSchema(db)
        client = typeof db.connect === 'function' ? await db.connect() : db
        await client.query('BEGIN')
        open = true
        const pause = await client.query('SELECT writes_paused FROM public.tron_transfer_sponsor_control WHERE id=1 FOR SHARE')
        if (pause.rows?.[0]?.writes_paused !== false) {
          await client.query('ROLLBACK'); open = false
          return reply(res, 423, { success: false, error: 'sponsor-writes-paused-for-maintenance', retryAllowed: false }, origin)
        }
        const found = await client.query(
          "SELECT operation,resource,amount_sun::text AS amount_sun,sponsor_address,owner_address,status,prepared_transaction FROM public.tron_transfer_sponsor_operations WHERE idempotency_key_hash=$1 AND sponsor_address=$2 FOR UPDATE",
          [keyHash, session.address],
        )
        const row = found.rows?.[0]
        if (!row || row.status !== 'reserved' || !row.prepared_transaction) {
          await client.query('ROLLBACK'); open = false
          return reply(res, 409, { success: false, error: 'prepared-operation-not-found-or-already-used', retryAllowed: false }, origin)
        }
        const result = await engine.submitSigned({
          signedTransaction: body.signedTransaction,
          preparedTransaction: row.prepared_transaction,
          operation: row.operation, resource: row.resource, amountSun: row.amount_sun, ownerAddress: row.owner_address,
          onSigned: async transactionId => {
            if (!TXID.test(transactionId || '') || transactionId !== row.prepared_transaction.txID) throw new Error('signed-transaction-id-mismatch')
            const saved = await client.query(
              "UPDATE public.tron_transfer_sponsor_operations SET status='signed-not-broadcast',transaction_id=$2,signed_transaction=$3::jsonb,updated_at=now() WHERE idempotency_key_hash=$1 AND status='reserved' AND EXISTS (SELECT 1 FROM public.tron_transfer_sponsor_control WHERE id=1 AND writes_paused=false) RETURNING id",
              [keyHash, transactionId, JSON.stringify(body.signedTransaction)],
            )
            if (!saved.rowCount) throw new Error('durable-signed-transaction-persistence-or-pause-check-failed')
            // Commit the signed payload and txID before any broadcast attempt.
            await client.query('COMMIT'); open = false
            if (client !== db) { client.release(); client = null }
            // Reacquire the shared control-row lock after persistence. A pause
            // that wins this gap prevents broadcast; a pause after this lock
            // waits until the in-flight broadcast/reconciliation completes.
            client = typeof db.connect === 'function' ? await db.connect() : db
            await client.query('BEGIN'); open = true
            const gate = await client.query('SELECT writes_paused FROM public.tron_transfer_sponsor_control WHERE id=1 FOR SHARE')
            if (gate.rows?.[0]?.writes_paused !== false) throw new Error('sponsor-writes-paused-before-broadcast')
            const claimed = await client.query(
              "SELECT status,transaction_id FROM public.tron_transfer_sponsor_operations WHERE idempotency_key_hash=$1 AND sponsor_address=$2 FOR UPDATE",
              [keyHash, session.address],
            )
            if (claimed.rows?.[0]?.status !== 'signed-not-broadcast' || claimed.rows[0].transaction_id !== transactionId) {
              throw new Error('durable-signed-operation-claim-failed')
            }
          },
        })
        const status = result.solidified ? 'confirmed' : result.broadcast ? 'broadcast-unknown' : result.signed ? 'signed-not-broadcast' : 'failed'
        if (client && open) {
          await client.query(
            'UPDATE public.tron_transfer_sponsor_operations SET status=$2,result_code=$3,confirmation_block=$4,updated_at=now() WHERE idempotency_key_hash=$1 AND status IN (\'signed-not-broadcast\',\'broadcast-unknown\')',
            [keyHash, status, result.status || 'unknown', result.blockNumber || null],
          )
          await client.query('COMMIT'); open = false
          if (client !== db) { client.release(); client = null }
        }
        return reply(res, result.success ? 200 : result.signed ? 202 : result.broadcast ? 202 : 422, {
          success: result.success === true, operationReference: body.operationReference, operationStatus: status,
          transactionId: result.txid || row.prepared_transaction.txID || null, resultCode: result.status || 'unknown',
          confirmationBlock: result.blockNumber || null, signed: result.signed === true,
          broadcast: result.broadcast === true, solidified: result.solidified === true, retryAllowed: false,
        }, origin)
      } catch {
        if (client && open) await client.query('ROLLBACK').catch(() => {})
        return reply(res, 503, { success: false, error: 'sponsor-signed-transaction-storage-or-execution-failed', retryAllowed: false }, origin)
      } finally { if (client && client !== db) client.release() }
    }

    if (req.method === 'POST' && path === '/api/sponsor/operations') {
      return reply(res, 410, { success: false, error: 'legacy-sponsor-server-signer-route-disabled', retryAllowed: false }, origin)
    }

    if (req.method === 'GET' && path === '/api/sponsor/operations') {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 50)))
      const db = getDatabase()
      if (!db) return reply(res, 503, { success: false, error: 'sponsor-ledger-unavailable' }, origin)
      try {
        await assertSchema(db)
        const result = await db.query(
          'SELECT operation,resource,amount_sun::text AS amount_sun,sponsor_address,owner_address,status,transaction_id,result_code,confirmation_block,created_at,updated_at FROM public.tron_transfer_sponsor_operations WHERE sponsor_address=$1 ORDER BY created_at DESC LIMIT $2',
          [session.address, limit],
        )
        return reply(res, 200, { success: true, network: 'TRON Mainnet', operations: result.rows || [], checkedAt: new Date(now()).toISOString() }, origin)
      } catch { return reply(res, 503, { success: false, error: 'sponsor-ledger-read-failed' }, origin) }
    }

    if (req.method === 'POST' && path === '/api/tron/sponsorship/resource-delegations/verify-wallet') {
      let body
      try { body = await readBody(req) } catch (error) { return reply(res, error.status || 400, { success: false, error: error.message }, origin) }
      if (body.network !== 'mainnet' || body.sponsorAddress !== session.address || body.receiverAddress !== ownerAddress
        || !TXID.test(body.transactionId || '') || !['ENERGY', 'BANDWIDTH'].includes(body.resourceType)
        || !positiveSun(String(body.stakeEquivalentSun || ''))) return reply(res, 400, { success: false, error: 'invalid-delegation-verification-request' }, origin)
      const db = getDatabase()
      if (!db) return reply(res, 503, { success: false, error: 'sponsor-ledger-unavailable' }, origin)
      try {
        await assertSchema(db)
        const result = await db.query(
          'SELECT idempotency_key_hash,amount_sun::text AS amount_sun,resource,status,transaction_id FROM public.tron_transfer_sponsor_operations WHERE sponsor_address=$1 AND owner_address=$2 AND operation=\'delegate\' AND transaction_id=$3',
          [session.address, ownerAddress, body.transactionId],
        )
        const row = result.rows?.[0]
        if (!row || row.amount_sun !== String(body.stakeEquivalentSun) || row.resource !== body.resourceType || row.status === 'failed') return reply(res, 404, { success: false, verified: false, error: 'delegation-not-in-sponsor-ledger' }, origin)
        const check = await engine.reconcile({
          transactionId: body.transactionId, operation: 'delegate', resource: body.resourceType,
          amountSun: row.amount_sun, sponsorAddress: session.address, ownerAddress,
        })
        if (check.confirmed) {
          await db.query('UPDATE public.tron_transfer_sponsor_operations SET status=\'confirmed\',result_code=$2,confirmation_block=$3,updated_at=now() WHERE idempotency_key_hash=$1', [row.idempotency_key_hash, check.status, check.blockNumber])
        }
        return reply(res, check.confirmed ? 200 : 202, {
          success: check.confirmed, verified: check.confirmed, transactionId: body.transactionId,
          sponsorAddress: session.address, receiverAddress: ownerAddress, resourceType: body.resourceType,
          stakeEquivalentSun: row.amount_sun, resultCode: check.status,
          persistence: { persisted: true }, solidified: check.confirmed, blockNumber: check.blockNumber || null,
        }, origin)
      } catch { return reply(res, 503, { success: false, verified: false, error: 'delegation-verification-unavailable' }, origin) }
    }

    const operationMatch = path.match(/^\/api\/sponsor\/operations\/([A-Za-z0-9._:-]+)$/)
    if (req.method === 'GET' && operationMatch) {
      const key = operationMatch[1]
      if (!IDEMPOTENCY.test(key)) return reply(res, 400, { success: false, error: 'invalid-idempotency-key' }, origin)
      const db = getDatabase()
      if (!db) return reply(res, 503, { success: false, error: 'sponsor-ledger-unavailable' }, origin)
      try {
        await assertSchema(db)
        const result = await db.query(
          'SELECT idempotency_key_hash,operation,resource,amount_sun::text AS amount_sun,sponsor_address,owner_address,status,transaction_id,result_code,confirmation_block FROM public.tron_transfer_sponsor_operations WHERE idempotency_key_hash=$1 AND sponsor_address=$2',
          [sha(key), session.address],
        )
        const row = result.rows?.[0]
        if (!row) return reply(res, 404, { success: false, error: 'sponsor-operation-not-found' }, origin)
        let reconciliation = null
        // The transaction ID is persisted before broadcast. Reconcile both
        // signed-not-broadcast and broadcast-unknown rows against solidified
        // Mainnet state. Never automatically re-sign or re-broadcast ambiguity.
        if (row.transaction_id && ['signed-not-broadcast', 'broadcast-unknown'].includes(row.status)) {
          reconciliation = await engine.reconcile({
            transactionId: row.transaction_id, operation: row.operation, resource: row.resource,
            amountSun: row.amount_sun, sponsorAddress: row.sponsor_address, ownerAddress: row.owner_address,
          })
          const confirmed = reconciliation.confirmed === true
          const solidifiedFailure = reconciliation.status === 'solidified-execution-failed'
          if (confirmed || solidifiedFailure) {
            const nextStatus = confirmed ? 'confirmed' : 'failed'
            await db.query(
              'UPDATE public.tron_transfer_sponsor_operations SET status=$2,result_code=$3,confirmation_block=$4,updated_at=now() WHERE idempotency_key_hash=$1',
              [row.idempotency_key_hash, nextStatus, reconciliation.status, reconciliation.blockNumber || null],
            )
            row.status = nextStatus
            row.result_code = reconciliation.status
            row.confirmation_block = reconciliation.blockNumber || null
          } else if (reconciliation.status) {
            await db.query(
              'UPDATE public.tron_transfer_sponsor_operations SET result_code=$2,updated_at=now() WHERE idempotency_key_hash=$1',
              [row.idempotency_key_hash, reconciliation.status],
            )
            row.result_code = reconciliation.status
          }
        }
        return reply(res, 200, {
          success: row.status === 'confirmed', operationReference: key, operation: row,
          reconciliation: reconciliation ? { attempted: true, confirmed: reconciliation.confirmed === true, status: reconciliation.status || 'unknown', blockNumber: reconciliation.blockNumber || null } : { attempted: false },
          retryAllowed: false,
        }, origin)
      } catch { return reply(res, 503, { success: false, error: 'sponsor-operation-reconciliation-unavailable', retryAllowed: false }, origin) }
    }

    return reply(res, 405, { success: false, error: 'method-not-allowed' }, origin)
  }

  return Object.freeze({ handle, readiness: () => engine.readiness() })
}
