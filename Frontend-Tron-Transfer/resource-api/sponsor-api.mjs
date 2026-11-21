import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import pg from 'pg'
import { TronWeb } from 'tronweb'
import { createSponsorTransactionEngine } from './sponsor-engine.mjs'

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
let schemaPromise

function sha(value) { return createHash('sha256').update(value).digest('hex') }
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
export function sponsorDatabaseConnectionString(env = process.env) {
  // Neon pooled URLs are preferred for the always-on Resource API. Keep the
  // direct DATABASE_URL for schema changes and one-off migration utilities.
  return env.DATABASE_URL_POOLED || env.DATABASE_URL || null
}

function getPool(env) {
  const connectionString = sponsorDatabaseConnectionString(env)
  if (!connectionString) return null
  if (!pool) {
    pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000, max: 3 })
    pool.on('error', error => process.stderr.write('Sponsor ledger database error: ' + String(error?.code || 'unknown') + '\n'))
  }
  return pool
}
async function ensureSchema(db) {
  if (!schemaPromise) schemaPromise = db.query(`
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
      result_code TEXT,
      confirmation_block BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE public.tron_transfer_sponsor_operations DROP CONSTRAINT IF EXISTS tron_transfer_sponsor_operations_operation_check;
    ALTER TABLE public.tron_transfer_sponsor_operations ADD CONSTRAINT tron_transfer_sponsor_operations_operation_check CHECK (operation IN ('stake','delegate','undelegate','unstake','withdraw','topup'));
    ALTER TABLE public.tron_transfer_sponsor_operations DROP CONSTRAINT IF EXISTS tron_transfer_sponsor_operations_resource_check;
    ALTER TABLE public.tron_transfer_sponsor_operations ADD CONSTRAINT tron_transfer_sponsor_operations_resource_check CHECK (resource IN ('ENERGY','BANDWIDTH','TRX'));
    CREATE INDEX IF NOT EXISTS tron_transfer_sponsor_operations_sponsor_created
      ON public.tron_transfer_sponsor_operations (sponsor_address, created_at DESC);
    CREATE TABLE IF NOT EXISTS public.tron_transfer_sponsor_control (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      writes_paused BOOLEAN NOT NULL DEFAULT FALSE,
      pause_reason TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    INSERT INTO public.tron_transfer_sponsor_control (id, writes_paused, pause_reason)
      VALUES (1, FALSE, NULL) ON CONFLICT (id) DO NOTHING;
  `).catch(error => { schemaPromise = null; throw error })
  await schemaPromise
}
async function readSponsorWritesPaused(db) {
  const result = await db.query('SELECT writes_paused FROM public.tron_transfer_sponsor_control WHERE id=1')
  return result.rows?.[0]?.writes_paused === true
}

function sessionSecret(env) {
  return typeof env.SPONSOR_SESSION_SECRET === 'string' && Buffer.byteLength(env.SPONSOR_SESSION_SECRET) >= 32
    ? env.SPONSOR_SESSION_SECRET : null
}
function adminTokenRequired(env) {
  return typeof env.SPONSOR_ADMIN_TOKEN === 'string' && env.SPONSOR_ADMIN_TOKEN.length > 0
}
function verifyAdminToken(req, env) {
  if (!adminTokenRequired(env)) return true
  const expected = env.SPONSOR_ADMIN_TOKEN
  return expected.length >= 32 && equalText(req.headers?.['x-sponsor-admin-token'], expected)
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

export function createSponsorResourceApi({
  env = process.env,
  allowedAddress = env.TRON_OWNER_ADDRESS || env.TRON_OWNER_WALLET_ADDRESS || 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp',
  fetchImpl = globalThis.fetch,
  engine = createSponsorTransactionEngine({ env, fetchImpl }),
  getDatabase = () => getPool(env),
  verifyMessage = async (message, signature) => {
    const verifier = new TronWeb({ fullHost: 'https://api.trongrid.io' })
    return verifier.trx.verifyMessageV2(message, signature)
  },
  send,
  now = () => Date.now(),
} = {}) {
  if (typeof send !== 'function') throw new TypeError('send response helper is required')
  const ownerAddress = allowedAddress
  const rateCounts = new Map()
  function rateLimit(req, key, max = 12) {
    const ip = String(req.socket?.remoteAddress || 'unknown').slice(0, 80)
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

  async function handle(req, res, url, origin) {
    const path = url.pathname
    const isRoute = path === '/api/sponsor/status'
      || path === '/api/sponsor/session/challenge'
      || path === '/api/sponsor/session/verify'
      || path === '/api/sponsor/intent'
      || path === '/api/sponsor/operations'
      || /^\/api\/sponsor\/operations\/[A-Za-z0-9._:-]+$/.test(path)
      || path === '/api/tron/sponsorship/resource-delegations'
      || path === '/api/tron/sponsorship/resource-delegations/verify-wallet'
    if (!isRoute) return false
    cleanup(now())

    if (req.method === 'GET' && path === '/api/sponsor/status') {
      const readiness = engine.readiness()
      const dbConfigured = Boolean(sponsorDatabaseConnectionString(env))
      const ownerAddressMatches = readiness.ownerAddress === ownerAddress
      const sponsorIndependent = validAddress(env.SPONSOR_MAINNET_ADDRESS) && env.SPONSOR_MAINNET_ADDRESS !== ownerAddress
      const adminRequired = adminTokenRequired(env)
      const adminConfigured = !adminRequired || env.SPONSOR_ADMIN_TOKEN.length >= 32
      let databaseReady = false
      let sponsorWritesPaused = false
      if (dbConfigured) {
        try {
          const db = getDatabase()
          if (db) {
            await ensureSchema(db)
            await db.query('SELECT 1')
            sponsorWritesPaused = await readSponsorWritesPaused(db)
            databaseReady = true
          }
        } catch { databaseReady = false }
      }
      return reply(res, 200, {
        success: true,
        network: 'TRON Mainnet',
        ownerAddress,
        sponsorAddress: validAddress(env.SPONSOR_MAINNET_ADDRESS) ? env.SPONSOR_MAINNET_ADDRESS : null,
        sessionAuthenticationConfigured: Boolean(sessionSecret(env)),
        databaseConfigured: dbConfigured,
        databaseReady,
        sponsorWritesPaused,
        ownerAddressMatches,
        sponsorIndependent,
        engineConfigured: readiness.configured === true,
        engineEnabled: readiness.enabled === true,
        transactionExecutionAvailable: readiness.broadcastAvailable === true && databaseReady && !sponsorWritesPaused && Boolean(sessionSecret(env)) && ownerAddressMatches && sponsorIndependent && adminConfigured,
        feePolicy: readiness.feePolicy,
        stakingPolicy: readiness.stakingPolicy,
        ownerTopupPolicy: readiness.ownerTopupPolicy,
        adminTokenRequired: adminRequired,
        adminTokenConfigured: adminConfigured,
        checkedAt: new Date(now()).toISOString(),
      }, origin)
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
        await ensureSchema(db)
        const result = await db.query(
          'SELECT transaction_id AS "transactionId",sponsor_address AS "sponsorAddress",owner_address AS "receiverAddress",resource AS "resourceType",amount_sun::text AS "stakeEquivalentSun",status,confirmation_block AS "blockNumber",created_at AS "recordedAt" FROM public.tron_transfer_sponsor_operations WHERE sponsor_address=$1 AND operation=\'delegate\' AND status=\'confirmed\' ORDER BY created_at DESC LIMIT $2',
          [address, limit],
        )
        return reply(res, 200, { success: true, network: 'TRON Mainnet', delegations: result.rows || [] }, origin)
      } catch { return reply(res, 503, { success: false, error: 'sponsor-ledger-read-failed' }, origin) }
    }

    const session = verifySession(req, env, now())
    if (!session) return reply(res, 401, { success: false, error: 'sponsor-session-required' }, origin)

    if (req.method === 'POST' && path === '/api/sponsor/intent') {
      if (!verifyAdminToken(req, env)) return reply(res, 403, { success: false, error: 'sponsor-admin-authorization-required' }, origin)
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

    if (req.method === 'POST' && path === '/api/sponsor/operations') {
      if (!verifyAdminToken(req, env)) return reply(res, 403, { success: false, error: 'sponsor-admin-authorization-required' }, origin)
      if (!rateLimit(req, 'execute', 3)) return reply(res, 429, { success: false, error: 'rate-limited' }, origin)
      let body
      try { body = await readBody(req) } catch (error) { return reply(res, error.status || 400, { success: false, error: error.message }, origin) }
      const intent = intents.get(body.intentId)
      if (!intent || intent.expiresAt <= now() || intent.sponsorAddress !== session.address) return reply(res, 409, { success: false, error: 'intent-expired-or-already-used', retryAllowed: false }, origin)
      intents.delete(body.intentId)
      if (body.confirmPhrase !== CONFIRMATION || typeof body.signature !== 'string' || !/^(?:0x)?[0-9a-f]{130}$/i.test(body.signature)) {
        return reply(res, 400, { success: false, error: 'explicit-confirmation-and-message-signature-required', retryAllowed: false }, origin)
      }
      try {
        const recovered = await verifyMessage(intent.message, body.signature)
        if (recovered !== session.address) return reply(res, 401, { success: false, error: 'operation-signature-address-mismatch', retryAllowed: false }, origin)
      } catch { return reply(res, 401, { success: false, error: 'operation-signature-verification-failed', retryAllowed: false }, origin) }

      const db = getDatabase()
      if (!db) return reply(res, 503, { success: false, error: 'durable-idempotency-storage-required', retryAllowed: false }, origin)
      const keyHash = sha(intent.idempotencyKey)
      const requestHash = sha(JSON.stringify({ operation: intent.operation, resource: intent.resource, amountSun: intent.amountSun, sponsorAddress: session.address, ownerAddress }))
      let reservationClient
      let reservationTransactionOpen = false
      try {
        await ensureSchema(db)
        reservationClient = typeof db.connect === 'function' ? await db.connect() : db
        await reservationClient.query('BEGIN')
        reservationTransactionOpen = true
        const pause = await reservationClient.query('SELECT writes_paused FROM public.tron_transfer_sponsor_control WHERE id=1 FOR SHARE')
        if (pause.rows?.[0]?.writes_paused === true) {
          await reservationClient.query('ROLLBACK')
          reservationTransactionOpen = false
          return reply(res, 423, { success: false, error: 'sponsor-writes-paused-for-maintenance', retryAllowed: false }, origin)
        }
        const reserved = await reservationClient.query(
          'INSERT INTO public.tron_transfer_sponsor_operations (idempotency_key_hash,request_hash,operation,resource,amount_sun,sponsor_address,owner_address,status) VALUES ($1,$2,$3,$4,$5,$6,$7,\'reserved\') ON CONFLICT (idempotency_key_hash) DO NOTHING RETURNING id',
          [keyHash, requestHash, intent.operation, intent.resource, intent.amountSun, session.address, ownerAddress],
        )
        if (!reserved.rowCount) {
          await reservationClient.query('ROLLBACK')
          reservationTransactionOpen = false
          const prior = await db.query('SELECT request_hash,status,transaction_id,result_code,confirmation_block FROM public.tron_transfer_sponsor_operations WHERE idempotency_key_hash=$1', [keyHash])
          const row = prior.rows?.[0]
          if (!row || row.request_hash !== requestHash) return reply(res, 409, { success: false, error: 'idempotency-key-reused-with-different-intent', retryAllowed: false }, origin)
          return reply(res, 409, { success: false, error: 'operation-already-recorded', operationReference: intent.idempotencyKey, operationStatus: row.status, transactionId: row.transaction_id, resultCode: row.result_code, confirmationBlock: row.confirmation_block, retryAllowed: false }, origin)
        }
        await reservationClient.query('COMMIT')
        reservationTransactionOpen = false
        if (reservationClient !== db) { reservationClient.release(); reservationClient = null }
        const result = await engine.execute({
          operation: intent.operation, resource: intent.resource, amountSun: intent.amountSun, ownerAddress,
          onSigned: async transactionId => {
            if (!TXID.test(transactionId || '')) throw new Error('invalid-signed-transaction-id')
            const saved = await db.query(
              'UPDATE public.tron_transfer_sponsor_operations SET status=\'broadcast-unknown\',transaction_id=$2,updated_at=now() WHERE idempotency_key_hash=$1 AND status=\'reserved\' RETURNING id',
              [keyHash, transactionId],
            )
            if (!saved.rowCount) throw new Error('durable-transaction-id-persistence-failed')
          },
        })
        const status = result.solidified ? 'confirmed' : result.broadcast ? 'broadcast-unknown' : result.signed ? 'signed-not-broadcast' : 'failed'
        await db.query(
          'UPDATE public.tron_transfer_sponsor_operations SET status=$2,transaction_id=COALESCE($3,transaction_id),result_code=$4,confirmation_block=$5,updated_at=now() WHERE idempotency_key_hash=$1',
          [keyHash, status, result.txid || null, result.status || 'unknown', result.blockNumber || null],
        )
        return reply(res, result.success ? 200 : result.broadcast ? 202 : 422, {
          success: result.success === true, operationReference: intent.idempotencyKey, operationStatus: status, transactionId: result.txid || null,
          resultCode: result.status || 'unknown', confirmationBlock: result.blockNumber || null,
          sponsorAddress: session.address, ownerAddress, operation: intent.operation, resource: intent.resource,
          amountSun: intent.amountSun, signed: result.signed === true, broadcast: result.broadcast === true,
          solidified: result.solidified === true, retryAllowed: false,
        }, origin)
      } catch {
        if (reservationClient && reservationTransactionOpen) await reservationClient.query('ROLLBACK').catch(() => {})
        return reply(res, 503, { success: false, error: 'sponsor-operation-storage-or-execution-failed', retryAllowed: false }, origin)
      } finally {
        if (reservationClient && reservationClient !== db) reservationClient.release()
      }
    }

    if (req.method === 'GET' && path === '/api/sponsor/operations') {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 50)))
      const db = getDatabase()
      if (!db) return reply(res, 503, { success: false, error: 'sponsor-ledger-unavailable' }, origin)
      try {
        await ensureSchema(db)
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
        await ensureSchema(db)
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
        await ensureSchema(db)
        const result = await db.query(
          'SELECT idempotency_key_hash,operation,resource,amount_sun::text AS amount_sun,sponsor_address,owner_address,status,transaction_id,result_code,confirmation_block FROM public.tron_transfer_sponsor_operations WHERE idempotency_key_hash=$1 AND sponsor_address=$2',
          [sha(key), session.address],
        )
        const row = result.rows?.[0]
        if (!row) return reply(res, 404, { success: false, error: 'sponsor-operation-not-found' }, origin)
        if (row.transaction_id && row.status === 'broadcast-unknown') {
          const check = await engine.reconcile({ transactionId: row.transaction_id, operation: row.operation, resource: row.resource, amountSun: row.amount_sun, sponsorAddress: row.sponsor_address, ownerAddress: row.owner_address })
          if (check.confirmed) {
            await db.query('UPDATE public.tron_transfer_sponsor_operations SET status=\'confirmed\',result_code=$2,confirmation_block=$3,updated_at=now() WHERE idempotency_key_hash=$1', [row.idempotency_key_hash, check.status, check.blockNumber])
            row.status = 'confirmed'
            row.result_code = check.status
            row.confirmation_block = check.blockNumber
          }
        }
        return reply(res, 200, { success: row.status === 'confirmed', operationReference: key, operation: row, retryAllowed: false }, origin)
      } catch { return reply(res, 503, { success: false, error: 'sponsor-operation-reconciliation-unavailable', retryAllowed: false }, origin) }
    }

    return reply(res, 405, { success: false, error: 'method-not-allowed' }, origin)
  }

  return Object.freeze({ handle, readiness: () => engine.readiness() })
}
