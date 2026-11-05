import { createHash, randomUUID } from 'node:crypto'
import { Router } from 'express'
import pg from 'pg'
import { TronWeb } from 'tronweb'
import {
  getWalletAuthSession,
  normalizeDatabaseConnectionString,
  databaseSslConfig,
} from '../database.mjs'
import { isValidTronAddress } from '../tron-address.mjs'
import { tatumProviderFetch } from '../tatum-provider-fetch.mjs'
import {
  MAINNET_USDT_CONTRACT,
  buildOwnerUsdtTransferParameter,
  parseOwnerUsdtAmount,
  validateOwnerSignedTransaction,
} from './tron-owner-withdrawals.mjs'
import { verifySolidifiedUsdtTransfer } from './tron-transfer.mjs'

const { Pool } = pg
const SCHEMA = 'trc20_token_clone'
const MAINNET_GATEWAY = 'https://tron-mainnet.gateway.tatum.io'
const ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TXID_RE = /^[0-9a-f]{64}$/i
const MAX_SIGNED_TRANSACTION_BYTES = 128 * 1024
const MAX_PREPARED_LIFETIME_MS = 10 * 60 * 1000
const SPONSOR_MATCH_LIFETIME_MS = 15 * 60 * 1000
const DEFAULT_FEE_LIMIT_SUN = '100000000'

let pool
let schemaPromise

function clean(value, max = 256) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function setNoStore(res) {
  res.setHeader('Cache-Control', 'no-store, private')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Vary', 'Origin, Authorization')
}

function requestOrigin(req) {
  const origin = clean(req.headers?.origin, 512)
  try {
    const parsed = new URL(origin)
    return parsed.origin === origin && parsed.protocol === 'https:' ? origin : ''
  } catch {
    return ''
  }
}

function configuredOrigins(env) {
  return [env.FRONTEND_ORIGIN, env.PACKAGED_APP_ORIGINS, env.OKX_UI_ORIGIN, env.TRON_TRANSFER_UI_ORIGIN]
    .flatMap((value) => typeof value === 'string' ? value.split(',') : [])
    .map((value) => value.trim())
    .filter(Boolean)
}

function bearerToken(req) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(clean(req.headers?.authorization, 4096))
  return match ? match[1] : ''
}

function getDatabase(env) {
  if (pool) return pool
  if (!clean(env.DATABASE_URL, 4096)) return null
  const connectionString = normalizeDatabaseConnectionString(env.DATABASE_URL)
  pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    max: 4,
    ssl: databaseSslConfig(connectionString, env),
  })
  pool.on('error', (error) => console.error('Sponsor-direct payout database error:', error?.code || 'unknown'))
  return pool
}

async function ensureSchema(db) {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await db.query('CREATE SCHEMA IF NOT EXISTS ' + SCHEMA)
      await db.query(
        'CREATE TABLE IF NOT EXISTS ' + SCHEMA + '.sponsor_direct_applications (' +
        'id UUID PRIMARY KEY, sponsor_address TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, ' +
        'contact_email TEXT, status TEXT NOT NULL DEFAULT \'pending-review\' ' +
        'CHECK (status IN (\'pending-review\',\'active\',\'declined\',\'suspended\')), ' +
        'per_payout_limit_base_units NUMERIC(78,0), daily_limit_base_units NUMERIC(78,0), ' +
        'review_reference TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), ' +
        'updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), reviewed_at TIMESTAMPTZ)'
      )
      await db.query(
        'CREATE INDEX IF NOT EXISTS sponsor_direct_applications_status_idx ON ' +
        SCHEMA + '.sponsor_direct_applications (status, created_at ASC)'
      )
      await db.query(
        'CREATE TABLE IF NOT EXISTS ' + SCHEMA + '.sponsor_direct_payouts (' +
        'id UUID PRIMARY KEY, idempotency_key UUID NOT NULL UNIQUE, requester_address TEXT NOT NULL, ' +
        'sponsor_address TEXT, recipient_address TEXT NOT NULL, token_contract TEXT NOT NULL, ' +
        'amount_base_units NUMERIC(78,0) NOT NULL CHECK (amount_base_units > 0), ' +
        'status TEXT NOT NULL DEFAULT \'requested\' CHECK (status IN ' +
        '(\'requested\',\'prepared\',\'broadcasting\',\'submitted\',\'outcome-unknown\',\'broadcast-rejected\',\'confirmed\',\'failed\',\'manual-review\',\'cancelled\',\'expired\')), ' +
        'unsigned_transaction JSONB, signed_transaction JSONB, transaction_hash CHAR(64), ' +
        'failure_code TEXT, expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), ' +
        'updated_at TIMESTAMPTZ NOT NULL DEFAULT now())'
      )
      await db.query(
        'CREATE INDEX IF NOT EXISTS sponsor_direct_payouts_requester_idx ON ' +
        SCHEMA + '.sponsor_direct_payouts (requester_address, created_at DESC)'
      )
      await db.query(
        'CREATE INDEX IF NOT EXISTS sponsor_direct_payouts_sponsor_status_idx ON ' +
        SCHEMA + '.sponsor_direct_payouts (sponsor_address, status, created_at DESC)'
      )
    })().catch((error) => {
      schemaPromise = null
      throw error
    })
  }
  await schemaPromise
}

export function parseSponsorDirectUsdtAmount(value) {
  return parseOwnerUsdtAmount(value)
}

export function calculateSponsorDirectAvailableBaseUnits(balanceBaseUnits, reservedBaseUnits) {
  const valid = (value) => /^(0|[1-9][0-9]*)$/.test(String(value))
  if (!valid(balanceBaseUnits) || !valid(reservedBaseUnits)) {
    throw new Error('Invalid sponsor USDT balance reservation values.')
  }
  const balance = BigInt(balanceBaseUnits)
  const reserved = BigInt(reservedBaseUnits)
  return (balance > reserved ? balance - reserved : 0n).toString()
}

function tronWebForMainnet() {
  return new TronWeb({ fullHost: MAINNET_GATEWAY })
}

function canonicalAddress(value, tronWeb) {
  const candidate = clean(value, 96)
  if (ADDRESS_RE.test(candidate) && isValidTronAddress(candidate)) return candidate
  const hex = candidate.replace(/^0x/i, '').toLowerCase()
  if (!/^(?:41)?[0-9a-f]{40}$/.test(hex)) return null
  try {
    const decoded = tronWeb.address.fromHex(hex.length === 40 ? '41' + hex : hex)
    return ADDRESS_RE.test(decoded) && isValidTronAddress(decoded) ? decoded : null
  } catch {
    return null
  }
}

export function matchesSponsorDirectUnsignedTransaction(transaction, intent) {
  if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) return false
  const { sponsorAddress, recipientAddress, amountBaseUnits, tronWeb = tronWebForMainnet() } = intent || {}
  if (!isValidTronAddress(sponsorAddress) || !isValidTronAddress(recipientAddress)
    || !/^[1-9][0-9]{0,77}$/.test(String(amountBaseUnits))) return false
  if (typeof transaction.txID !== 'string' || !TXID_RE.test(transaction.txID)
    || typeof transaction.raw_data_hex !== 'string'
    || !/^(?:[0-9a-f]{2})+$/i.test(transaction.raw_data_hex)) return false
  const calculated = createHash('sha256').update(Buffer.from(transaction.raw_data_hex, 'hex')).digest('hex')
  if (calculated.toLowerCase() !== transaction.txID.toLowerCase()) return false
  const contracts = transaction.raw_data?.contract
  if (!Array.isArray(contracts) || contracts.length !== 1 || contracts[0]?.type !== 'TriggerSmartContract') return false
  const value = contracts[0]?.parameter?.value
  if (!value || canonicalAddress(value.owner_address, tronWeb) !== sponsorAddress
    || canonicalAddress(value.contract_address, tronWeb) !== MAINNET_USDT_CONTRACT
    || Number(value.call_value || 0) !== 0) return false
  const expectedData = 'a9059cbb' + buildOwnerUsdtTransferParameter(recipientAddress, String(amountBaseUnits), tronWeb)
  if (typeof value.data !== 'string' || value.data.replace(/^0x/i, '').toLowerCase() !== expectedData) return false
  const expiration = Number(transaction.raw_data?.expiration)
  const now = Date.now()
  return Number.isSafeInteger(expiration) && expiration > now
    && expiration <= now + MAX_PREPARED_LIFETIME_MS + 30000
}

function tatumApiKey(env) {
  return clean(env.TATUM_MAINNET_API_KEY || env.TATUM_API_KEY, 2048)
}

async function tatumPost(env, path, body) {
  const key = tatumApiKey(env)
  if (!key) throw Object.assign(new Error('Tatum Mainnet API key is not configured.'), { status: 503 })
  const response = await tatumProviderFetch(MAINNET_GATEWAY + '/' + path.replace(/^\/+/, ''), {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify(body || {}),
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload || payload.Error || payload.error) {
    throw Object.assign(new Error('Tatum Mainnet request failed.'), { status: response.status || 502 })
  }
  return payload
}

async function readSponsorSnapshot(env, sponsorAddress) {
  const tronWeb = tronWebForMainnet()
  const addressHex = tronWeb.address.toHex(sponsorAddress).replace(/^41/i, '').toLowerCase()
  const [account, resources, token] = await Promise.all([
    tatumPost(env, 'walletsolidity/getaccount', { address: sponsorAddress, visible: true }),
    tatumPost(env, 'wallet/getaccountresource', { address: sponsorAddress, visible: true }),
    tatumPost(env, 'walletsolidity/triggerconstantcontract', {
      owner_address: sponsorAddress,
      contract_address: MAINNET_USDT_CONTRACT,
      function_selector: 'balanceOf(address)',
      parameter: addressHex.padStart(64, '0'),
      visible: true,
    }),
  ])
  const tokenHex = Array.isArray(token?.constant_result) ? token.constant_result[0] : ''
  if (typeof tokenHex !== 'string' || !/^[0-9a-f]{1,64}$/i.test(tokenHex)) {
    throw Object.assign(new Error('Official Mainnet USDT balance could not be verified.'), { status: 502 })
  }
  const trxRaw = account?.balance
  const trxBalanceSun = /^(0|[1-9][0-9]*)$/.test(String(trxRaw ?? '')) ? String(trxRaw) : null
  const readResource = (value) => {
    const number = Number(value)
    return value !== undefined && value !== null && Number.isSafeInteger(number) && number >= 0 ? number : null
  }
  const energyLimit = readResource(resources?.EnergyLimit)
  const energyUsed = readResource(resources?.EnergyUsed)
  const netLimit = readResource(resources?.NetLimit)
  const netUsed = readResource(resources?.NetUsed)
  const freeNetLimit = readResource(resources?.freeNetLimit)
  const freeNetUsed = readResource(resources?.freeNetUsed)
  const resourcesReadable = [energyLimit, energyUsed, netLimit, netUsed, freeNetLimit, freeNetUsed]
    .every((value) => value !== null)
  return {
    sponsorAddress,
    network: 'mainnet',
    tokenContract: MAINNET_USDT_CONTRACT,
    usdtBalanceBaseUnits: BigInt('0x' + tokenHex).toString(),
    trxBalanceSun,
    energyAvailable: resourcesReadable ? Math.max(0, energyLimit - energyUsed) : null,
    bandwidthAvailable: resourcesReadable
      ? Math.max(0, netLimit - netUsed) + Math.max(0, freeNetLimit - freeNetUsed)
      : null,
    resourcesReadable,
    checkedAt: new Date().toISOString(),
  }
}

async function requireWalletSession(req, env, getSession, now) {
  const origin = requestOrigin(req)
  const token = bearerToken(req)
  if (!origin || !configuredOrigins(env).includes(origin) || !token) {
    return { ok: false, status: 401, error: 'mainnet-wallet-session-required' }
  }
  let lookup
  try {
    lookup = await getSession({ tokenHash: digest(token), origin, nowMs: now() })
  } catch {
    lookup = null
  }
  const session = lookup?.session
  if (lookup?.success !== true) return { ok: false, status: 503, error: 'wallet-session-storage-unavailable' }
  if (!session || session.network !== 'mainnet' || session.origin !== origin || session.expiresAt <= now()
    || !isValidTronAddress(session.address)) {
    return { ok: false, status: 401, error: 'wallet-session-invalid-or-expired' }
  }
  return { ok: true, address: session.address, origin }
}

async function requirePlatformOwner(req, env, getSession, now) {
  const auth = await requireWalletSession(req, env, getSession, now)
  if (!auth.ok) return auth
  const configuredOwner = clean(env.OWNER_WALLET_ADDRESS, 64)
  if (!isValidTronAddress(configuredOwner)) {
    return { ok: false, status: 503, error: 'platform-owner-not-configured' }
  }
  if (auth.address !== configuredOwner) return { ok: false, status: 403, error: 'platform-owner-only' }
  return auth
}

async function getSponsorProfile(db, address) {
  const result = await db.query(
    'SELECT * FROM ' + SCHEMA + '.sponsor_direct_applications WHERE sponsor_address=$1 LIMIT 1',
    [address],
  )
  return result.rows[0] || null
}

function publicApplication(row) {
  if (!row) return null
  return {
    id: row.id,
    sponsorAddress: row.sponsor_address,
    displayName: row.display_name,
    status: row.status,
    perPayoutLimitBaseUnits: row.per_payout_limit_base_units == null ? null : String(row.per_payout_limit_base_units),
    dailyLimitBaseUnits: row.daily_limit_base_units == null ? null : String(row.daily_limit_base_units),
    reviewReference: row.review_reference || null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    ...(row.reviewed_at ? { reviewedAt: new Date(row.reviewed_at).toISOString() } : {}),
  }
}

function publicRequest(row) {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    requesterAddress: row.requester_address,
    sponsorAddress: row.sponsor_address || null,
    network: 'mainnet',
    asset: 'USDT',
    tokenContract: row.token_contract,
    recipientAddress: row.recipient_address,
    amountBaseUnits: String(row.amount_base_units),
    status: row.status,
    transactionHash: row.transaction_hash ? String(row.transaction_hash).trim() : null,
    failureCode: row.failure_code || null,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

async function readReservations(db, sponsorAddress, excludeRequestId = null) {
  const result = await db.query(
    'SELECT COALESCE(SUM(amount_base_units),0)::text AS reserved FROM ' + SCHEMA +
    '.sponsor_direct_payouts WHERE sponsor_address=$1 AND (' +
    '(status=\'requested\' AND (expires_at IS NULL OR expires_at > now())) OR ' +
    '(status=\'prepared\' AND (expires_at IS NULL OR expires_at > now())) OR ' +
    'status IN (\'broadcasting\',\'submitted\',\'outcome-unknown\',\'manual-review\')) ' +
    'AND ($2::uuid IS NULL OR id <> $2::uuid)',
    [sponsorAddress, excludeRequestId],
  )
  const value = String(result.rows?.[0]?.reserved ?? '0')
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('Sponsor reservation ledger is unreadable.')
  return value
}

async function releaseExpiredSponsorMatches(db) {
  await db.query(
    'UPDATE ' + SCHEMA + '.sponsor_direct_payouts ' +
    'SET sponsor_address=NULL, expires_at=NULL, failure_code=\'sponsor-match-expired\', updated_at=now() ' +
    'WHERE status=\'requested\' AND sponsor_address IS NOT NULL ' +
    'AND expires_at IS NOT NULL AND expires_at <= now()',
  )
}

async function readDailyUsage(db, sponsorAddress, excludeRequestId = null) {
  const result = await db.query(
    'SELECT COALESCE(SUM(amount_base_units),0)::text AS used FROM ' + SCHEMA +
    '.sponsor_direct_payouts WHERE sponsor_address=$1 AND created_at >= ' +
    '(date_trunc(\'day\', now() AT TIME ZONE \'UTC\') AT TIME ZONE \'UTC\') ' +
    'AND status NOT IN (\'failed\',\'cancelled\',\'expired\',\'broadcast-rejected\') ' +
    'AND (status <> \'requested\' OR expires_at IS NULL OR expires_at > now()) ' +
    'AND ($2::uuid IS NULL OR id <> $2::uuid)',
    [sponsorAddress, excludeRequestId],
  )
  const value = String(result.rows?.[0]?.used ?? '0')
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('Sponsor daily-usage ledger is unreadable.')
  return value
}

function hasFeeCoverage(snapshot, simulation, unsignedTransaction, feeLimitSun) {
  const energyUsed = Number(simulation?.energy_used)
  const energyPenalty = Number(simulation?.energy_penalty || 0)
  const energyRequired = Number.isSafeInteger(energyUsed) && energyUsed >= 0
    && Number.isSafeInteger(energyPenalty) && energyPenalty >= 0
    ? Math.ceil((energyUsed + energyPenalty) * 1.2) : null
  const bandwidthRequired = typeof unsignedTransaction?.raw_data_hex === 'string'
    ? Math.ceil(unsignedTransaction.raw_data_hex.length / 2) + 100 : null
  const resourcesCovered = energyRequired !== null && snapshot.energyAvailable !== null
    && snapshot.energyAvailable >= energyRequired
    && bandwidthRequired !== null && snapshot.bandwidthAvailable !== null
    && snapshot.bandwidthAvailable >= bandwidthRequired
  let trxCovered = false
  try {
    trxCovered = snapshot.trxBalanceSun !== null && BigInt(snapshot.trxBalanceSun) >= BigInt(feeLimitSun)
  } catch {}
  return {
    covered: resourcesCovered || trxCovered,
    method: resourcesCovered ? 'verified-energy-and-bandwidth' : trxCovered ? 'trx-fee-limit-reserve' : 'insufficient-sponsor-network-resources',
    energyRequired,
    bandwidthRequired,
  }
}

async function getAuthorizedSponsorMandate(db, sponsorAddress, nowMs) {
  try {
    const result = await db.query(
      'SELECT m.* FROM ' + SCHEMA + '.sponsor_organization_mandates m ' +
      'JOIN ' + SCHEMA + '.sponsor_organization_applications a ON a.id=m.application_id ' +
      'WHERE m.sponsor_wallet_address=$1 AND a.sponsor_wallet_address=$1 ' +
      'AND a.status=\'accepted-for-due-diligence\' AND m.status=\'authorized\' ' +
      'AND m.purpose=\'both\' ' +
      'AND m.valid_from <= $2 AND m.valid_until > $2 ' +
      'ORDER BY m.updated_at DESC LIMIT 1',
      [sponsorAddress, new Date(nowMs).toISOString()],
    )
    return result.rows[0] || null
  } catch {
    // Missing organization/mandate schema, stale DB state, or query errors all fail closed.
    return null
  }
}

function lowerBaseUnitLimit(left, right) {
  const a = BigInt(String(left || '0'))
  const b = BigInt(String(right || '0'))
  return (a < b ? a : b).toString()
}

export function isSponsorDirectAutoRouteEligible({
  amountBaseUnits,
  balanceBaseUnits,
  reservedBaseUnits,
  perPayoutLimitBaseUnits,
  dailyLimitBaseUnits,
  dailyUsedBaseUnits,
  feeCoverage,
}) {
  const values = [
    amountBaseUnits,
    balanceBaseUnits,
    reservedBaseUnits,
    perPayoutLimitBaseUnits,
    dailyLimitBaseUnits,
    dailyUsedBaseUnits,
  ].map(String)
  if (values.some((value) => !/^(0|[1-9][0-9]*)$/.test(value))) return false
  const [amount, balance, reserved, perPayout, dailyLimit, dailyUsed] = values.map(BigInt)
  const available = balance > reserved ? balance - reserved : 0n
  return feeCoverage === true
    && amount > 0n
    && amount <= perPayout
    && amount <= available
    && dailyUsed + amount <= dailyLimit
}

async function autoAssignSponsorToRequest({
  db,
  env,
  request,
  now,
  readSnapshot,
  providerPost,
}) {
  if (!request || request.status !== 'requested' || request.sponsor_address) {
    return { request, routing: request?.sponsor_address ? 'already-assigned' : 'awaiting-eligible-sponsor' }
  }
  const amountBaseUnits = String(request.amount_base_units || '')
  if (!/^[1-9][0-9]{0,77}$/.test(amountBaseUnits)) {
    return { request, routing: 'awaiting-eligible-sponsor' }
  }
  let candidates
  try {
    await releaseExpiredSponsorMatches(db)
    const found = await db.query(
      'SELECT DISTINCT s.sponsor_address FROM ' + SCHEMA + '.sponsor_direct_applications s ' +
      'JOIN ' + SCHEMA + '.sponsor_organization_applications a ' +
      'ON a.sponsor_wallet_address=s.sponsor_address ' +
      'JOIN ' + SCHEMA + '.sponsor_organization_mandates m ' +
      'ON m.application_id=a.id AND m.sponsor_wallet_address=s.sponsor_address ' +
      'WHERE s.status=\'active\' AND a.status=\'accepted-for-due-diligence\' ' +
      'AND m.status=\'authorized\' AND m.purpose=\'both\' ' +
      'AND m.valid_from <= $1 AND m.valid_until > $1 ' +
      'AND s.sponsor_address <> $2 ' +
      'AND ($4::text IS NULL OR s.sponsor_address <> $4::text) ' +
      'AND s.per_payout_limit_base_units >= $3::numeric ' +
      'AND m.per_payout_limit_base_units >= $3::numeric ' +
      'AND NOT EXISTS (SELECT 1 FROM ' + SCHEMA + '.sponsor_direct_payouts p ' +
      'WHERE p.sponsor_address=s.sponsor_address AND p.status=\'requested\' ' +
      'AND (p.expires_at IS NULL OR p.expires_at > now())) ' +
      'ORDER BY s.updated_at ASC LIMIT 10',
      [
        new Date(now()).toISOString(),
        request.requester_address,
        amountBaseUnits,
        isValidTronAddress(clean(env.OWNER_WALLET_ADDRESS, 64)) ? clean(env.OWNER_WALLET_ADDRESS, 64) : null,
      ],
    )
    candidates = found.rows || []
  } catch {
    // Organization tables may not yet exist; preserve the request in the unassigned queue.
    return { request, routing: 'awaiting-eligible-sponsor' }
  }

  const tronWeb = tronWebForMainnet()
  const feeLimitSun = clean(env.SPONSOR_DIRECT_TRON_USDT_FEE_LIMIT_SUN || DEFAULT_FEE_LIMIT_SUN, 32)
  if (!/^[1-9][0-9]{0,9}$/.test(feeLimitSun) || BigInt(feeLimitSun) > 1000000000n) {
    return { request, routing: 'awaiting-eligible-sponsor' }
  }

  for (const candidate of candidates) {
    const sponsorAddress = candidate.sponsor_address
    let client

    async function clientlessSponsorPreflight() {
      const snapshot = await readSnapshot(env, sponsorAddress)
      const parameter = buildOwnerUsdtTransferParameter(
        request.recipient_address,
        amountBaseUnits,
        tronWeb,
      )
      const transferBody = {
        owner_address: sponsorAddress,
        contract_address: MAINNET_USDT_CONTRACT,
        function_selector: 'transfer(address,uint256)',
        parameter,
        fee_limit: Number(feeLimitSun),
        call_value: 0,
        visible: true,
      }
      const simulation = await providerPost(env, 'wallet/triggerconstantcontract', transferBody)
      if (simulation?.result?.result !== true) return
      const built = await providerPost(env, 'wallet/triggersmartcontract', transferBody)
      const unsignedTransaction = built?.transaction
      if (built?.result?.result !== true || !matchesSponsorDirectUnsignedTransaction(
        unsignedTransaction,
        { sponsorAddress, recipientAddress: request.recipient_address, amountBaseUnits, tronWeb },
      )) return
      const feeCoverage = hasFeeCoverage(snapshot, simulation, unsignedTransaction, feeLimitSun)
      if (!feeCoverage.covered) return

      client = await db.connect()
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['sponsor-direct:' + sponsorAddress])
      const locked = await client.query(
        'SELECT * FROM ' + SCHEMA + '.sponsor_direct_payouts WHERE id=$1 FOR UPDATE',
        [request.id],
      )
      const current = locked.rows[0]
      if (!current || current.status !== 'requested' || current.sponsor_address) {
        await client.query('ROLLBACK')
        return
      }

      const profile = await getSponsorProfile(client, sponsorAddress)
      const mandate = await getAuthorizedSponsorMandate(client, sponsorAddress, now())
      if (!profile || profile.status !== 'active' || !mandate || mandate.purpose !== 'both') {
        await client.query('ROLLBACK')
        return
      }
      const otherPending = await client.query(
        'SELECT id FROM ' + SCHEMA + '.sponsor_direct_payouts ' +
        'WHERE sponsor_address=$1 AND status=\'requested\' AND id<>$2 ' +
        'AND (expires_at IS NULL OR expires_at > now()) LIMIT 1',
        [sponsorAddress, request.id],
      )
      if (otherPending.rows.length) {
        await client.query('ROLLBACK')
        return
      }
      const [latestSnapshot, reservedBaseUnits, dailyUsedBaseUnits] = await Promise.all([
        readSnapshot(env, sponsorAddress),
        readReservations(client, sponsorAddress),
        readDailyUsage(client, sponsorAddress),
      ])
      const perPayoutLimit = lowerBaseUnitLimit(
        profile.per_payout_limit_base_units,
        mandate.per_payout_limit_base_units,
      )
      const dailyLimit = lowerBaseUnitLimit(
        profile.daily_limit_base_units,
        mandate.daily_limit_base_units,
      )
      if (!isSponsorDirectAutoRouteEligible({
        amountBaseUnits,
        balanceBaseUnits: latestSnapshot.usdtBalanceBaseUnits,
        reservedBaseUnits,
        perPayoutLimitBaseUnits: perPayoutLimit,
        dailyLimitBaseUnits: dailyLimit,
        dailyUsedBaseUnits,
        feeCoverage: hasFeeCoverage(latestSnapshot, simulation, unsignedTransaction, feeLimitSun).covered,
      })) {
        await client.query('ROLLBACK')
        return
      }
      const assigned = await client.query(
        'UPDATE ' + SCHEMA + '.sponsor_direct_payouts ' +
        'SET sponsor_address=$2, expires_at=$3, failure_code=NULL, updated_at=now() ' +
        'WHERE id=$1 AND status=\'requested\' AND sponsor_address IS NULL RETURNING *',
        [request.id, sponsorAddress, new Date(now() + SPONSOR_MATCH_LIFETIME_MS).toISOString()],
      )
      if (!assigned.rowCount) {
        await client.query('ROLLBACK')
        return
      }
      await client.query('COMMIT')
      return assigned.rows[0]
    }

    try {
      const assigned = await clientlessSponsorPreflight()
      if (assigned) {
        return { request: assigned, routing: 'auto-assigned-awaiting-sponsor-signature' }
      }
    } catch {
      if (client) {
        try { await client.query('ROLLBACK') } catch {}
      }
    } finally {
      client?.release()
    }
  }
  return { request, routing: 'awaiting-eligible-sponsor' }
}

export function createSponsorDirectPayoutsRouter({
  env = process.env,
  getSession = getWalletAuthSession,
  now = () => Date.now(),
  readSnapshot = readSponsorSnapshot,
  providerPost = tatumPost,
  verifyTransfer = verifySolidifiedUsdtTransfer,
  getDatabase = getPool,
} = {}) {
  const router = Router()

  router.get('/config', (_req, res) => {
    setNoStore(res)
    return res.json({
      success: true,
      network: 'mainnet',
      asset: 'USDT',
      tokenContract: MAINNET_USDT_CONTRACT,
      payoutMode: 'sponsor-direct',
      requesterWalletFundingRequired: false,
      requesterWalletSignaturePurpose: 'identity-only',
      requestIntakeEnabled: true,
      sponsorWalletFundingRequired: true,
      sponsorWalletSignatureRequired: true,
      payoutExecution: 'conditional-on-approved-funded-sponsor',
      sponsorApprovalRequired: true,
      sponsorOrganizationVerification: 'platform-review-required; legal-entity and KYC verification are not performed by this application',
      note: 'A requester can submit a withdrawal request with a zero-balance wallet. An actual payout executes only after an approved sponsor wallet is verified to hold the official Mainnet USDT amount and sufficient TRON network resources, and the sponsor signs the exact transaction in its own wallet.',
    })
  })

  router.get('/application', async (req, res) => {
    setNoStore(res)
    const auth = await requireWalletSession(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const db = getDatabase(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const row = await getSponsorProfile(db, auth.address)
      return res.json({ success: true, application: publicApplication(row), complianceVerified: false })
    } catch {
      return res.status(503).json({ success: false, error: 'sponsor-application-unavailable' })
    }
  })

  router.post('/application', async (req, res) => {
    setNoStore(res)
    const auth = await requireWalletSession(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const configuredOwner = clean(env.OWNER_WALLET_ADDRESS, 64)
    if (isValidTronAddress(configuredOwner) && auth.address === configuredOwner) {
      return res.status(403).json({ success: false, error: 'platform-owner-wallet-cannot-act-as-third-party-sponsor' })
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).some((key) => !['displayName', 'contactEmail'].includes(key))) {
      return res.status(400).json({ success: false, error: 'unexpected-fields' })
    }
    const displayName = clean(body.displayName, 120)
    const contactEmail = clean(body.contactEmail, 254).toLowerCase()
    if (displayName.length < 2
      || (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(contactEmail))) {
      return res.status(400).json({ success: false, error: 'invalid-sponsor-profile' })
    }
    const db = getDatabase(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const existing = await getSponsorProfile(db, auth.address)
      if (existing) return res.status(409).json({ success: false, error: 'sponsor-application-already-exists', application: publicApplication(existing) })
      const id = randomUUID()
      const result = await db.query(
        'INSERT INTO ' + SCHEMA + '.sponsor_direct_applications ' +
        '(id,sponsor_address,display_name,contact_email,status) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [id, auth.address, displayName, contactEmail || null, 'pending-review'],
      )
      return res.status(201).json({
        success: true,
        application: publicApplication(result.rows[0]),
        complianceVerified: false,
        canSubmitSponsoredTransfer: false,
        submissionEnabled: false,
        note: 'This is an individual self-custody sponsor wallet application. It does not certify a company, business registration, KYC, or legal authority. The platform owner must review it, and the wallet must sign every payout.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'sponsor-application-create-failed' })
    }
  })

  router.get('/applications', async (req, res) => {
    setNoStore(res)
    const auth = await requirePlatformOwner(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const db = getDatabase(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const result = await db.query(
        'SELECT * FROM ' + SCHEMA + '.sponsor_direct_applications WHERE status=\'pending-review\' ORDER BY created_at ASC LIMIT 50',
      )
      return res.json({
        success: true,
        applications: result.rows.map((row) => ({
          ...publicApplication(row),
          contactEmail: row.contact_email || null,
        })),
        complianceVerified: false,
        approvalMeaning: 'platform-wallet-participation-only; not legal-entity verification or KYC',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'sponsor-application-review-list-unavailable' })
    }
  })

  router.post('/applications/:id/review', async (req, res) => {
    setNoStore(res)
    const auth = await requirePlatformOwner(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const id = clean(req.params?.id, 64)
    if (!UUID_RE.test(id)) return res.status(400).json({ success: false, error: 'invalid-application-id' })
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).some((key) => !['decision', 'reviewReference', 'perPayoutLimit', 'dailyLimit'].includes(key))) {
      return res.status(400).json({ success: false, error: 'unexpected-fields' })
    }
    const decision = body.decision
    const reviewReference = clean(body.reviewReference, 160)
    if (!['approve', 'decline'].includes(decision) || reviewReference.length < 2) {
      return res.status(400).json({ success: false, error: 'invalid-sponsor-review' })
    }
    let perPayoutBaseUnits = null
    let dailyBaseUnits = null
    if (decision === 'approve') {
      try {
        perPayoutBaseUnits = parseSponsorDirectUsdtAmount(body.perPayoutLimit)
        dailyBaseUnits = parseSponsorDirectUsdtAmount(body.dailyLimit)
      } catch {
        return res.status(400).json({ success: false, error: 'valid-payout-and-daily-limits-required' })
      }
      if (BigInt(dailyBaseUnits) < BigInt(perPayoutBaseUnits)) {
        return res.status(400).json({ success: false, error: 'daily-limit-must-cover-per-payout-limit' })
      }
    }
    const db = getDatabase(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const result = await db.query(
        'UPDATE ' + SCHEMA + '.sponsor_direct_applications SET status=$2, review_reference=$3, ' +
        'per_payout_limit_base_units=$4, daily_limit_base_units=$5, updated_at=now(), reviewed_at=now() ' +
        'WHERE id=$1 AND status=\'pending-review\' RETURNING *',
        [id, decision === 'approve' ? 'active' : 'declined', reviewReference,
          perPayoutBaseUnits, dailyBaseUnits],
      )
      if (!result.rowCount) return res.status(409).json({ success: false, error: 'application-not-pending-or-not-found' })
      return res.json({
        success: true,
        application: publicApplication(result.rows[0]),
        complianceVerified: false,
        note: decision === 'approve'
          ? 'The platform has approved this self-custody wallet for sponsor participation within the configured caps. This is not legal-entity verification, KYC, or a guarantee of funds.'
          : 'The sponsor wallet application was declined.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'sponsor-application-review-failed' })
    }
  })

  router.get('/readiness', async (req, res) => {
    setNoStore(res)
    const auth = await requireWalletSession(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const db = getDatabase(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    if (!tatumApiKey(env)) return res.status(503).json({ success: false, error: 'tatum-mainnet-key-not-configured' })
    try {
      await ensureSchema(db)
      const profile = await getSponsorProfile(db, auth.address)
      if (!profile || profile.status !== 'active') {
        return res.status(403).json({
          success: false,
          error: 'active-sponsor-application-required',
          application: publicApplication(profile),
          canSubmitSponsoredTransfer: false,
          submissionEnabled: false,
        })
      }
      const mandate = await getAuthorizedSponsorMandate(db, auth.address, now())
      if (!mandate) {
        return res.status(403).json({
          success: false,
          error: 'authorized-sponsor-organization-mandate-required',
          canSponsorPayouts: false,
          canSubmitSponsoredTransfer: false,
          submissionEnabled: false,
          note: 'A wallet-only sponsor application is insufficient. An organization application, signed written mandate and separate owner authorization are required.',
        })
      }
      const [snapshot, reservedBaseUnits, dailyUsedBaseUnits] = await Promise.all([
        readSnapshot(env, auth.address),
        readReservations(db, auth.address),
        readDailyUsage(db, auth.address),
      ])
      const availableBaseUnits = calculateSponsorDirectAvailableBaseUnits(snapshot.usdtBalanceBaseUnits, reservedBaseUnits)
      const dailyLimit = lowerBaseUnitLimit(profile.daily_limit_base_units, mandate.daily_limit_base_units)
      const perPayoutLimit = lowerBaseUnitLimit(profile.per_payout_limit_base_units, mandate.per_payout_limit_base_units)
      const dailyRemaining = calculateSponsorDirectAvailableBaseUnits(dailyLimit, dailyUsedBaseUnits)
      return res.json({
        success: true,
        sponsorAddress: auth.address,
        network: 'mainnet',
        tokenContract: MAINNET_USDT_CONTRACT,
        usdtBalanceBaseUnits: snapshot.usdtBalanceBaseUnits,
        reservedUsdtBaseUnits: reservedBaseUnits,
        availableUsdtBaseUnits: availableBaseUnits,
        trxBalanceSun: snapshot.trxBalanceSun,
        energyAvailable: snapshot.energyAvailable,
        bandwidthAvailable: snapshot.bandwidthAvailable,
        resourcesReadable: snapshot.resourcesReadable,
        perPayoutLimitBaseUnits: perPayoutLimit,
        dailyLimitBaseUnits: dailyLimit,
        dailyUsedBaseUnits,
        dailyRemainingBaseUnits: dailyRemaining,
        checkedAt: snapshot.checkedAt,
        canSponsorPayouts: BigInt(availableBaseUnits) > 0n && BigInt(dailyRemaining) > 0n,
        note: 'All USDT availability comes from the sponsor wallet on solidified Mainnet state, less active reservations. This balance is not the requester’s wallet balance.',
      })
    } catch (error) {
      return res.status(Number.isInteger(error?.status) ? error.status : 502).json({
        success: false,
        error: 'sponsor-mainnet-readiness-unavailable',
      })
    }
  })

  router.post('/requests', async (req, res) => {
    setNoStore(res)
    const auth = await requireWalletSession(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).some((key) => !['recipientAddress', 'amount', 'idempotencyKey'].includes(key))) {
      return res.status(400).json({ success: false, error: 'unexpected-fields' })
    }
    const recipientAddress = clean(body.recipientAddress, 64)
    const idempotencyKey = clean(body.idempotencyKey, 64)
    if (!ADDRESS_RE.test(recipientAddress) || !isValidTronAddress(recipientAddress)) {
      return res.status(400).json({ success: false, error: 'invalid-recipient-address' })
    }
    if (!UUID_RE.test(idempotencyKey)) return res.status(400).json({ success: false, error: 'valid-idempotency-key-required' })
    let amountBaseUnits
    try { amountBaseUnits = parseSponsorDirectUsdtAmount(body.amount) } catch {
      return res.status(400).json({ success: false, error: 'invalid-usdt-amount' })
    }
    const db = getDatabase(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const existing = await db.query(
        'SELECT * FROM ' + SCHEMA + '.sponsor_direct_payouts WHERE idempotency_key=$1 LIMIT 1',
        [idempotencyKey],
      )
      if (existing.rows[0]) {
        const row = existing.rows[0]
        if (row.requester_address !== auth.address || row.recipient_address !== recipientAddress
          || String(row.amount_base_units) !== amountBaseUnits) {
          return res.status(409).json({ success: false, error: 'idempotency-key-reused-for-different-request' })
        }
        return res.json({ success: true, duplicate: true, request: publicRequest(row), payoutAuthorized: false })
      }
      const result = await db.query(
        'INSERT INTO ' + SCHEMA + '.sponsor_direct_payouts ' +
        '(id,idempotency_key,requester_address,recipient_address,token_contract,amount_base_units,status) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,\'requested\') RETURNING *',
        [randomUUID(), idempotencyKey, auth.address, recipientAddress, MAINNET_USDT_CONTRACT, amountBaseUnits],
      )
      const routed = await autoAssignSponsorToRequest({
        db,
        env,
        request: result.rows[0],
        now,
        readSnapshot,
        providerPost,
      })
      return res.status(201).json({
        success: true,
        request: publicRequest(routed.request || result.rows[0]),
        sponsorRouting: routed.routing,
        payoutAuthorized: false,
        transactionBroadcast: false,
        note: routed.routing === 'auto-assigned-awaiting-sponsor-signature'
          ? 'An eligible sponsor was automatically matched using a fresh Mainnet USDT and fee-resource check. The sponsor must still review and sign the exact payout in its own wallet. No funds have moved yet.'
          : 'Your zero-balance wallet submitted the request. No currently eligible sponsor could be matched; it remains in the approved sponsor queue until a sponsor with an authorized mandate and sufficient funds/resources can accept it. No funds have moved.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'sponsor-withdrawal-request-storage-unavailable' })
    }
  })

  router.get('/my-requests', async (req, res) => {
    setNoStore(res)
    const auth = await requireWalletSession(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const db = getDatabase(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const result = await db.query(
        'SELECT * FROM ' + SCHEMA + '.sponsor_direct_payouts WHERE requester_address=$1 ORDER BY created_at DESC LIMIT 50',
        [auth.address],
      )
      return res.json({
        success: true,
        requests: result.rows.map((row) => ({
          ...publicRequest(row),
          ...(row.status === 'prepared' && row.sponsor_address === auth.address && row.unsigned_transaction
            ? { unsignedTransaction: row.unsigned_transaction }
            : {}),
        })),
      })
    } catch {
      return res.status(503).json({ success: false, error: 'sponsor-withdrawal-history-unavailable' })
    }
  })

  router.get('/queue', async (req, res) => {
    setNoStore(res)
    const auth = await requireWalletSession(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const db = getDatabase(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const profile = await getSponsorProfile(db, auth.address)
      if (!profile || profile.status !== 'active') {
        return res.status(403).json({ success: false, error: 'active-sponsor-application-required' })
      }
      const mandate = await getAuthorizedSponsorMandate(db, auth.address, now())
      if (!mandate || mandate.purpose !== 'both') {
        return res.json({
          success: true,
          requests: [],
          canReceivePayoutRequests: false,
          note: 'An active wallet sponsor application and an authorized, unexpired organization mandate for USDT principal and network fees are required before this sponsor can receive payout requests.',
        })
      }
      await releaseExpiredSponsorMatches(db)
      const result = await db.query(
        'SELECT * FROM ' + SCHEMA + '.sponsor_direct_payouts WHERE ' +
        '((status=\'requested\' AND (sponsor_address IS NULL OR sponsor_address=$1)) OR sponsor_address=$1) ' +
        'ORDER BY created_at ASC LIMIT 50',
        [auth.address],
      )
      return res.json({ success: true, requests: result.rows.map((row) => ({
        ...publicRequest(row),
        ...(row.status === 'prepared' && row.sponsor_address === auth.address && row.unsigned_transaction
          ? { unsignedTransaction: row.unsigned_transaction }
          : {}),
      })) })
    } catch {
      return res.status(503).json({ success: false, error: 'sponsor-withdrawal-queue-unavailable' })
    }
  })

  router.post('/requests/:id/prepare', async (req, res) => {
    setNoStore(res)
    const auth = await requireWalletSession(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const id = clean(req.params?.id, 64)
    if (!UUID_RE.test(id)) return res.status(400).json({ success: false, error: 'invalid-payout-request-id' })
    const db = getDatabase(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    if (!tatumApiKey(env)) return res.status(503).json({ success: false, error: 'tatum-mainnet-key-not-configured' })
    const tronWeb = tronWebForMainnet()
    const feeLimitSun = clean(env.SPONSOR_DIRECT_TRON_USDT_FEE_LIMIT_SUN || DEFAULT_FEE_LIMIT_SUN, 32)
    if (!/^[1-9][0-9]{0,9}$/.test(feeLimitSun) || BigInt(feeLimitSun) > 1000000000n) {
      return res.status(503).json({ success: false, error: 'invalid-sponsor-fee-limit-configuration' })
    }
    let client
    try {
      await ensureSchema(db)
      client = await db.connect()
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['sponsor-direct:' + auth.address])
      const found = await client.query(
        'SELECT * FROM ' + SCHEMA + '.sponsor_direct_payouts WHERE id=$1 FOR UPDATE',
        [id],
      )
      if (!found.rows.length) {
        await client.query('ROLLBACK')
        return res.status(404).json({ success: false, error: 'payout-request-not-found' })
      }
      let row = found.rows[0]
      if (row.status === 'prepared' && row.sponsor_address === auth.address
        && row.expires_at && new Date(row.expires_at).getTime() > now()) {
        await client.query('COMMIT')
        return res.json({
          success: true,
          duplicate: true,
          request: publicRequest(row),
          unsignedTransaction: row.unsigned_transaction,
          note: 'The same unexpired sponsor preparation was returned. No second payout was created.',
        })
      }
      if (row.status === 'requested' && row.sponsor_address === auth.address
        && row.expires_at && new Date(row.expires_at).getTime() <= now()) {
        const released = await client.query(
          'UPDATE ' + SCHEMA + '.sponsor_direct_payouts SET sponsor_address=NULL, expires_at=NULL, ' +
          'failure_code=\'sponsor-match-expired\', updated_at=now() ' +
          'WHERE id=$1 AND status=\'requested\' AND sponsor_address=$2 RETURNING *',
          [id, auth.address],
        )
        await client.query('COMMIT')
        return res.status(409).json({
          success: false,
          error: 'sponsor-match-expired',
          request: publicRequest(released.rows[0] || row),
          note: 'The temporary sponsor match expired before preparation. The request is unassigned and available for another eligible sponsor.',
        })
      }
      // An expired unsigned preparation may be released and claimed again.
      // Signed, broadcasting and ambiguous payouts are never reset or reassigned.
      if (row.status === 'prepared' && row.expires_at
        && new Date(row.expires_at).getTime() <= now() && !row.signed_transaction) {
        const released = await client.query(
          'UPDATE ' + SCHEMA + '.sponsor_direct_payouts SET status=\'requested\', sponsor_address=NULL, ' +
          'unsigned_transaction=NULL, transaction_hash=NULL, expires_at=NULL, failure_code=\'unsigned-transaction-expired\', updated_at=now() ' +
          'WHERE id=$1 AND status=\'prepared\' AND expires_at <= now() AND signed_transaction IS NULL RETURNING *',
          [id],
        )
        if (released.rowCount) row = released.rows[0]
      }
      if (row.sponsor_address && row.sponsor_address !== auth.address) {
        await client.query('ROLLBACK')
        return res.status(403).json({ success: false, error: 'payout-automatically-assigned-to-another-sponsor' })
      }
      if (row.status !== 'requested') {
        await client.query('ROLLBACK')
        return res.status(409).json({ success: false, error: 'payout-request-not-available', request: publicRequest(row) })
      }
      const profile = await getSponsorProfile(client, auth.address)
      if (!profile || profile.status !== 'active') {
        await client.query('ROLLBACK')
        return res.status(403).json({ success: false, error: 'active-sponsor-application-required' })
      }
      const mandate = await getAuthorizedSponsorMandate(client, auth.address, now())
      if (!mandate) {
        await client.query('ROLLBACK')
        return res.status(403).json({ success: false, error: 'authorized-sponsor-organization-mandate-required' })
      }
      const [snapshot, reservedBaseUnits, dailyUsedBaseUnits] = await Promise.all([
        readSnapshot(env, auth.address),
        readReservations(client, auth.address, id),
        readDailyUsage(client, auth.address, id),
      ])
      const amountBaseUnits = String(row.amount_base_units)
      const availableBaseUnits = calculateSponsorDirectAvailableBaseUnits(snapshot.usdtBalanceBaseUnits, reservedBaseUnits)
      const perPayoutLimit = lowerBaseUnitLimit(profile.per_payout_limit_base_units, mandate.per_payout_limit_base_units)
      const dailyLimit = lowerBaseUnitLimit(profile.daily_limit_base_units, mandate.daily_limit_base_units)
      if (BigInt(amountBaseUnits) > BigInt(perPayoutLimit)) {
        await client.query('ROLLBACK')
        return res.status(409).json({ success: false, error: 'sponsor-per-payout-limit-exceeded', availableBaseUnits, requestedBaseUnits: amountBaseUnits })
      }
      if (BigInt(availableBaseUnits) < BigInt(amountBaseUnits)) {
        await client.query('ROLLBACK')
        return res.status(409).json({
          success: false,
          error: 'sponsor-insufficient-mainnet-usdt-balance',
          onChainBalanceBaseUnits: snapshot.usdtBalanceBaseUnits,
          reservedBaseUnits,
          availableBaseUnits,
          requestedBaseUnits: amountBaseUnits,
        })
      }
      if (BigInt(dailyUsedBaseUnits) + BigInt(amountBaseUnits) > BigInt(dailyLimit)) {
        await client.query('ROLLBACK')
        return res.status(409).json({ success: false, error: 'sponsor-daily-limit-exceeded', dailyLimitBaseUnits: dailyLimit, dailyUsedBaseUnits })
      }

      const recipientAddress = row.recipient_address
      const parameter = buildOwnerUsdtTransferParameter(recipientAddress, amountBaseUnits, tronWeb)
      const requestBody = {
        owner_address: auth.address,
        contract_address: MAINNET_USDT_CONTRACT,
        function_selector: 'transfer(address,uint256)',
        parameter,
        fee_limit: Number(feeLimitSun),
        call_value: 0,
        visible: true,
      }
      const simulation = await providerPost(env, 'wallet/triggerconstantcontract', requestBody)
      if (simulation?.result?.result !== true) {
        await client.query('ROLLBACK')
        return res.status(409).json({
          success: false,
          error: 'sponsor-transfer-preflight-failed',
          note: 'Tatum did not confirm this exact transfer call. No transaction was signed or broadcast.',
        })
      }
      const built = await providerPost(env, 'wallet/triggersmartcontract', requestBody)
      const unsignedTransaction = built?.transaction
      const intent = { sponsorAddress: auth.address, recipientAddress, amountBaseUnits, tronWeb }
      if (built?.result?.result !== true || !matchesSponsorDirectUnsignedTransaction(unsignedTransaction, intent)) {
        await client.query('ROLLBACK')
        return res.status(502).json({ success: false, error: 'tatum-unsigned-sponsor-transaction-invalid' })
      }
      const feeCoverage = hasFeeCoverage(snapshot, simulation, unsignedTransaction, feeLimitSun)
      if (!feeCoverage.covered) {
        await client.query('ROLLBACK')
        return res.status(409).json({
          success: false,
          error: 'sponsor-network-fee-resources-insufficient',
          feeCoverage,
          trxBalanceSun: snapshot.trxBalanceSun,
          energyAvailable: snapshot.energyAvailable,
          bandwidthAvailable: snapshot.bandwidthAvailable,
          note: 'The sponsor must cover the estimated Energy and Bandwidth with verified resources or hold enough TRX for the configured fee limit. The requester’s wallet is not charged.',
        })
      }
      const expiration = Number(unsignedTransaction.raw_data.expiration)
      const updated = await client.query(
        'UPDATE ' + SCHEMA + '.sponsor_direct_payouts SET sponsor_address=$2, status=\'prepared\', ' +
        'unsigned_transaction=$3::jsonb, transaction_hash=$4, expires_at=$5, failure_code=NULL, updated_at=now() ' +
        'WHERE id=$1 AND status=\'requested\' RETURNING *',
        [id, auth.address, JSON.stringify(unsignedTransaction), unsignedTransaction.txID, new Date(expiration).toISOString()],
      )
      if (!updated.rowCount) {
        await client.query('ROLLBACK')
        return res.status(409).json({ success: false, error: 'payout-request-was-claimed' })
      }
      await client.query('COMMIT')
      return res.status(201).json({
        success: true,
        request: publicRequest(updated.rows[0]),
        unsignedTransaction,
        feeLimitSun,
        feeCoverage,
        snapshot: {
          usdtBalanceBaseUnits: snapshot.usdtBalanceBaseUnits,
          reservedUsdtBaseUnits: reservedBaseUnits,
          availableUsdtBaseUnits: availableBaseUnits,
          trxBalanceSun: snapshot.trxBalanceSun,
          energyAvailable: snapshot.energyAvailable,
          bandwidthAvailable: snapshot.bandwidthAvailable,
          checkedAt: snapshot.checkedAt,
        },
        note: 'Review the recipient, amount and fee coverage. Only the approved sponsor address can sign this exact transfer. No funds move until that sponsor approves in its own TronLink wallet.',
      })
    } catch (error) {
      if (client) {
        try { await client.query('ROLLBACK') } catch {}
      }
      return res.status(Number.isInteger(error?.status) ? error.status : 502).json({
        success: false,
        error: error?.status === 503 ? 'tatum-mainnet-unavailable-or-not-configured' : 'sponsor-payout-preparation-failed',
      })
    } finally {
      client?.release()
    }
  })

  router.post('/requests/:id/broadcast', async (req, res) => {
    setNoStore(res)
    const auth = await requireWalletSession(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const id = clean(req.params?.id, 64)
    if (!UUID_RE.test(id)) return res.status(400).json({ success: false, error: 'invalid-payout-request-id' })
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).some((key) => key !== 'signedTransaction')) {
      return res.status(400).json({ success: false, error: 'unexpected-fields' })
    }
    const signedTransaction = body.signedTransaction
    let serialized
    try { serialized = JSON.stringify(signedTransaction) } catch { serialized = '' }
    if (!serialized || serialized.length > MAX_SIGNED_TRANSACTION_BYTES) {
      return res.status(400).json({ success: false, error: 'invalid-signed-transaction-size' })
    }
    const db = getDatabase(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    let row
    let client
    try {
      await ensureSchema(db)
      client = await db.connect()
      await client.query('BEGIN')
      const found = await client.query(
        'SELECT * FROM ' + SCHEMA + '.sponsor_direct_payouts WHERE id=$1 FOR UPDATE',
        [id],
      )
      if (!found.rows.length) {
        await client.query('ROLLBACK')
        return res.status(404).json({ success: false, error: 'payout-request-not-found' })
      }
      row = found.rows[0]
      if (row.sponsor_address !== auth.address) {
        await client.query('ROLLBACK')
        return res.status(403).json({ success: false, error: 'assigned-sponsor-only' })
      }
      const profile = await getSponsorProfile(client, auth.address)
      if (!profile || profile.status !== 'active') {
        await client.query('ROLLBACK')
        return res.status(403).json({ success: false, error: 'active-sponsor-application-required' })
      }
      const mandate = await getAuthorizedSponsorMandate(client, auth.address, now())
      if (!mandate
        || BigInt(String(row.amount_base_units)) > BigInt(String(mandate.per_payout_limit_base_units))) {
        await client.query('ROLLBACK')
        return res.status(403).json({ success: false, error: 'authorized-sponsor-mandate-invalid-or-expired' })
      }
      if (row.status !== 'prepared') {
        await client.query('ROLLBACK')
        return res.status(409).json({ success: false, error: 'payout-not-in-prepared-state', request: publicRequest(row) })
      }
      if (!row.expires_at || new Date(row.expires_at).getTime() <= now()) {
        await client.query(
          'UPDATE ' + SCHEMA + '.sponsor_direct_payouts SET status=\'expired\', failure_code=\'unsigned-transaction-expired\', updated_at=now() WHERE id=$1',
          [id],
        )
        await client.query('COMMIT')
        return res.status(409).json({ success: false, error: 'unsigned-transaction-expired' })
      }
      const intent = {
        ownerAddress: auth.address,
        recipientAddress: row.recipient_address,
        amountBaseUnits: String(row.amount_base_units),
        tronWeb: tronWebForMainnet(),
      }
      const validation = validateOwnerSignedTransaction(signedTransaction, row.unsigned_transaction, intent)
      if (!validation.ok) {
        await client.query('ROLLBACK')
        return res.status(401).json({ success: false, error: validation.reason })
      }
      const approved = await providerPost(env, 'wallet/getapprovedlist', {
        signature: signedTransaction.signature,
        raw_data: signedTransaction.raw_data,
        visible: true,
      })
      const approvedAddresses = Array.isArray(approved?.approved_list) ? approved.approved_list : []
      if (approved?.result?.result !== true || approved?.result?.code || !approvedAddresses.includes(auth.address)) {
        await client.query('ROLLBACK')
        return res.status(401).json({ success: false, error: 'sponsor-signature-not-approved-by-tron-network' })
      }
      await client.query(
        'UPDATE ' + SCHEMA + '.sponsor_direct_payouts SET status=\'broadcasting\', signed_transaction=$2::jsonb, updated_at=now() WHERE id=$1',
        [id, JSON.stringify(signedTransaction)],
      )
      await client.query('COMMIT')
    } catch {
      if (client) {
        try { await client.query('ROLLBACK') } catch {}
      }
      return res.status(503).json({ success: false, error: 'sponsor-payout-broadcast-validation-failed' })
    } finally {
      client?.release()
    }

    let broadcast
    try {
      broadcast = await providerPost(env, 'wallet/broadcasttransaction', signedTransaction)
    } catch {
      await db.query(
        'UPDATE ' + SCHEMA + '.sponsor_direct_payouts SET status=\'outcome-unknown\', failure_code=\'tatum-broadcast-outcome-unknown\', updated_at=now() WHERE id=$1 AND status=\'broadcasting\'',
        [id],
      )
      return res.status(202).json({
        success: true,
        status: 'outcome-unknown',
        transactionHash: row.transaction_hash,
        note: 'Tatum did not return a conclusive broadcast response. The fixed transaction ID will be checked on Mainnet. Do not sign or submit a replacement payment.',
      })
    }
    if (broadcast?.result !== true) {
      await db.query(
        'UPDATE ' + SCHEMA + '.sponsor_direct_payouts SET status=\'broadcast-rejected\', failure_code=$2, updated_at=now() WHERE id=$1 AND status=\'broadcasting\'',
        [id, clean(broadcast?.code || broadcast?.message, 128) || 'tatum-broadcast-rejected'],
      )
      return res.status(409).json({ success: false, error: 'tatum-broadcast-rejected' })
    }
    await db.query(
      'UPDATE ' + SCHEMA + '.sponsor_direct_payouts SET status=\'submitted\', failure_code=NULL, updated_at=now() WHERE id=$1 AND status IN (\'broadcasting\',\'outcome-unknown\')',
      [id],
    )
    return res.status(202).json({
      success: true,
      status: 'submitted',
      transactionHash: row.transaction_hash,
      note: 'Tatum accepted the sponsor-signed transfer. Final confirmation remains pending until the solidified Mainnet receipt and official USDT Transfer event are verified.',
    })
  })

  router.get('/requests/:id', async (req, res) => {
    setNoStore(res)
    const auth = await requireWalletSession(req, env, getSession, now)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const id = clean(req.params?.id, 64)
    if (!UUID_RE.test(id)) return res.status(400).json({ success: false, error: 'invalid-payout-request-id' })
    const db = getDatabase(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const found = await db.query('SELECT * FROM ' + SCHEMA + '.sponsor_direct_payouts WHERE id=$1 LIMIT 1', [id])
      if (!found.rows.length) return res.status(404).json({ success: false, error: 'payout-request-not-found' })
      let row = found.rows[0]
      if (row.requester_address !== auth.address && row.sponsor_address !== auth.address) {
        return res.status(403).json({ success: false, error: 'payout-request-access-denied' })
      }
      if (['submitted', 'outcome-unknown', 'broadcasting'].includes(row.status)) {
        const verification = await verifyTransfer(env, {
          transactionHash: String(row.transaction_hash || '').trim(),
          from: row.sponsor_address,
          to: row.recipient_address,
          amountBaseUnits: String(row.amount_base_units),
        })
        let nextStatus = row.status
        let failureCode = row.failure_code || null
        if (verification?.verified === true) {
          nextStatus = 'confirmed'
          failureCode = null
        } else if (verification?.status === 'solidified-transaction-failed') {
          nextStatus = 'failed'
          failureCode = 'confirmed-solidified-transaction-failed'
        } else if (['solidified-transfer-mismatch', 'ambiguous-transfer-event'].includes(verification?.status)) {
          nextStatus = 'manual-review'
          failureCode = verification.status
        }
        if (nextStatus !== row.status || failureCode !== row.failure_code) {
          const updated = await db.query(
            'UPDATE ' + SCHEMA + '.sponsor_direct_payouts SET status=$2, failure_code=$3, updated_at=now() WHERE id=$1 RETURNING *',
            [id, nextStatus, failureCode],
          )
          row = updated.rows[0] || row
        }
      }
      return res.json({
        success: true,
        request: publicRequest(row),
        confirmation: row.status === 'confirmed'
          ? { verified: true, source: 'Tatum solidified Mainnet receipt and exact official-USDT Transfer event' }
          : null,
        exchangeCreditStatus: 'not-verified-by-tron-chain',
        note: row.status === 'confirmed'
          ? 'The official USDT transfer is confirmed on TRON Mainnet. An exchange must independently confirm its internal deposit credit.'
          : 'A request, sponsor approval, prepared transaction or broadcast acceptance is not a confirmed transfer.',
      })
    } catch {
      return res.status(502).json({ success: false, error: 'payout-request-status-unavailable' })
    }
  })

  return router
}

export default createSponsorDirectPayoutsRouter()
