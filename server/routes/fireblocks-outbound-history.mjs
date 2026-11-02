import { createHash, randomUUID } from 'node:crypto'
import { Router } from 'express'
import pg from 'pg'
import {
  getWalletAuthSession,
  normalizeDatabaseConnectionString,
  databaseSslConfig,
} from '../database.mjs'
import {
  createFireblocksClient,
  fireblocksConfiguration,
  parseSixDecimalBaseUnits,
} from '../fireblocks-client.mjs'

const { Pool } = pg
const SCHEMA = 'trc20_token_clone'
const HISTORY_START_MS = '1'
const HISTORY_MAX_AGE_MS = 10 * 60 * 1000
const PAGE_SIZE = 500
const MAX_PAGES_PER_CALL = 20
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const TXID_PATTERN = /^[0-9a-f]{64}$/i
const FINAL_NO_BROADCAST_STATUSES = new Set(['FAILED', 'CANCELLED', 'REJECTED', 'BLOCKED'])
let pool

function getPool(env) {
  if (pool) return pool
  if (typeof env.DATABASE_URL !== 'string' || !env.DATABASE_URL.trim()) return null
  const connectionString = normalizeDatabaseConnectionString(env.DATABASE_URL)
  pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    max: 3,
    ssl: databaseSslConfig(connectionString, env),
  })
  pool.on('error', (error) => console.error('Fireblocks outbound history database error:', error?.code || 'unknown'))
  return pool
}

async function ensureHistorySchema(db) {
  await db.query('CREATE SCHEMA IF NOT EXISTS ' + SCHEMA)
  await db.query(
    'CREATE TABLE IF NOT EXISTS ' + SCHEMA + '.fireblocks_outbound_history_state (' +
    'vault_account_id TEXT PRIMARY KEY,' +
    'treasury_address TEXT NOT NULL,' +
    'history_start_ms BIGINT NOT NULL DEFAULT 1,' +
    'history_end_ms BIGINT NOT NULL,' +
    'usdt_asset_id TEXT,' +
    'trx_asset_id TEXT,' +
    'current_run_id TEXT,' +
    'previous_complete_transaction_count BIGINT NOT NULL DEFAULT 0,' +
    "status TEXT NOT NULL CHECK (status IN ('scanning','complete','blocked'))," +
    'next_page_cursor TEXT,' +
    'page_count INTEGER NOT NULL DEFAULT 0,' +
    'transaction_count BIGINT NOT NULL DEFAULT 0,' +
    'external_usdt_base_units NUMERIC(78,0) NOT NULL DEFAULT 0,' +
    'external_trx_base_units NUMERIC(78,0) NOT NULL DEFAULT 0,' +
    'reconciliation_digest CHAR(64),' +
    'failure_code TEXT,' +
    'checked_at TIMESTAMPTZ,' +
    'updated_at TIMESTAMPTZ NOT NULL DEFAULT now()' +
    ')',
  )
  await db.query(
    'CREATE TABLE IF NOT EXISTS ' + SCHEMA + '.fireblocks_outbound_history_entries (' +
    'provider_transaction_id TEXT PRIMARY KEY,' +
    'vault_account_id TEXT NOT NULL,' +
    'asset_id TEXT NOT NULL,' +
    "asset_code TEXT NOT NULL CHECK (asset_code IN ('USDT','TRX'))," +
    'amount_base_units NUMERIC(78,0) NOT NULL CHECK (amount_base_units > 0),' +
    "operation TEXT NOT NULL CHECK (operation = 'TRANSFER')," +
    'provider_status TEXT NOT NULL,' +
    'external_tx_id TEXT,' +
    'transaction_hash CHAR(64),' +
    'source_type TEXT NOT NULL,' +
    'source_id TEXT NOT NULL,' +
    'destination_type TEXT NOT NULL,' +
    'destination_id TEXT,' +
    'destination_address TEXT,' +
    'created_at_ms BIGINT NOT NULL,' +
    'raw_sha256 CHAR(64) NOT NULL,' +
    'terminal_no_broadcast BOOLEAN NOT NULL DEFAULT false,' +
    'last_seen_run_id TEXT,' +
    'first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),' +
    'last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()' +
    ')',
  )
  await db.query('ALTER TABLE ' + SCHEMA + '.fireblocks_outbound_history_state ADD COLUMN IF NOT EXISTS usdt_asset_id TEXT')
  await db.query('ALTER TABLE ' + SCHEMA + '.fireblocks_outbound_history_state ADD COLUMN IF NOT EXISTS trx_asset_id TEXT')
  await db.query('ALTER TABLE ' + SCHEMA + '.fireblocks_outbound_history_state ADD COLUMN IF NOT EXISTS current_run_id TEXT')
  await db.query('ALTER TABLE ' + SCHEMA + '.fireblocks_outbound_history_state ADD COLUMN IF NOT EXISTS previous_complete_transaction_count BIGINT NOT NULL DEFAULT 0')
  await db.query('ALTER TABLE ' + SCHEMA + '.fireblocks_outbound_history_entries ADD COLUMN IF NOT EXISTS last_seen_run_id TEXT')
  await db.query(
    'CREATE INDEX IF NOT EXISTS fireblocks_outbound_history_vault_asset_idx ' +
    'ON ' + SCHEMA + '.fireblocks_outbound_history_entries (vault_account_id, asset_code)',
  )
  await db.query(
    'CREATE INDEX IF NOT EXISTS fireblocks_outbound_history_external_id_idx ' +
    'ON ' + SCHEMA + '.fireblocks_outbound_history_entries (external_tx_id)',
  )
  // The history synchronizer can run before the withdrawal UI has initialized
  // its tables. Create the same minimal ledger shape and columns used by that
  // route so reconciliation never silently treats a missing table as no payouts.
  await db.query(
    'CREATE TABLE IF NOT EXISTS ' + SCHEMA + '.treasury_withdrawal_requests (' +
    'id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,' +
    'idempotency_key TEXT NOT NULL UNIQUE,' +
    'owner_address TEXT NOT NULL,' +
    'treasury_address TEXT NOT NULL,' +
    'recipient_address TEXT NOT NULL,' +
    'token_contract TEXT NOT NULL,' +
    'amount_base_units NUMERIC(78,0) NOT NULL CHECK (amount_base_units > 0),' +
    "status TEXT NOT NULL CHECK (status IN ('broadcasting','provider-pending','broadcast-accepted','broadcast-unknown','rejected','confirmed','failed'))," +
    'transaction_hash CHAR(64),' +
    'provider_transaction_id TEXT,' +
    'provider_status TEXT,' +
    'failure_code TEXT,' +
    'created_at TIMESTAMPTZ NOT NULL DEFAULT now(),' +
    'updated_at TIMESTAMPTZ NOT NULL DEFAULT now()' +
    ')',
  )
  await db.query('ALTER TABLE ' + SCHEMA + '.treasury_withdrawal_requests ADD COLUMN IF NOT EXISTS provider_transaction_id TEXT')
  await db.query('ALTER TABLE ' + SCHEMA + '.treasury_withdrawal_requests ADD COLUMN IF NOT EXISTS provider_status TEXT')
  await db.query(
    'CREATE TABLE IF NOT EXISTS ' + SCHEMA + '.treasury_trx_withdrawal_requests (' +
    'id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,' +
    'idempotency_key TEXT NOT NULL UNIQUE,' +
    'owner_address TEXT NOT NULL,' +
    'treasury_address TEXT NOT NULL,' +
    'recipient_address TEXT NOT NULL,' +
    'amount_base_units NUMERIC(78,0) NOT NULL CHECK (amount_base_units > 0),' +
    "status TEXT NOT NULL CHECK (status IN ('broadcasting','provider-pending','broadcast-accepted','broadcast-unknown','rejected','confirmed','failed'))," +
    'transaction_hash CHAR(64),' +
    'provider_transaction_id TEXT,' +
    'provider_status TEXT,' +
    'failure_code TEXT,' +
    'created_at TIMESTAMPTZ NOT NULL DEFAULT now(),' +
    'updated_at TIMESTAMPTZ NOT NULL DEFAULT now()' +
    ')',
  )
  await db.query('ALTER TABLE ' + SCHEMA + '.treasury_trx_withdrawal_requests ADD COLUMN IF NOT EXISTS provider_transaction_id TEXT')
  await db.query('ALTER TABLE ' + SCHEMA + '.treasury_trx_withdrawal_requests ADD COLUMN IF NOT EXISTS provider_status TEXT')
}

function parseCreatedAtMs(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  if (typeof value === 'string' && /^[0-9]{10,16}$/.test(value)) {
    const number = Number(value)
    return Number.isSafeInteger(number) && number > 0 ? number : null
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
  }
  return null
}

function safeText(value, max = 256) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
    && !/[\r\n]/.test(value) ? value.trim() : ''
}

export function parseFireblocksOutboundHistoryTransaction(transaction, {
  vaultAccountId,
  usdtAssetId,
  trxAssetId,
} = {}) {
  const id = safeText(transaction?.id || transaction?.transactionId, 128)
  const operation = safeText(transaction?.operation, 64).toUpperCase()
  const status = safeText(transaction?.status, 64).toUpperCase()
  const sourceType = safeText(transaction?.source?.type, 64).toUpperCase()
  const sourceId = safeText(transaction?.source?.id, 128)
  const assetId = safeText(transaction?.assetId, 128)
  const amount = typeof transaction?.amount === 'string' ? transaction.amount : ''
  const amountBaseUnits = parseSixDecimalBaseUnits(amount)
  const createdAtMs = parseCreatedAtMs(transaction?.createdAt)
  const externalTxId = safeText(transaction?.externalTxId, 128) || null
  const rawHash = safeText(transaction?.txHash, 128)
  const transactionHash = rawHash
    ? rawHash.replace(/^0x/i, '').toLowerCase()
    : null
  const destination = transaction?.destination && typeof transaction.destination === 'object'
    ? transaction.destination : {}
  const destinationType = safeText(destination.type, 64).toUpperCase()
  const destinationId = safeText(destination.id, 128) || null
  const destinationAddress = safeText(
    destination.oneTimeAddress?.address || destination.address, 64,
  ) || null
  const supportedDestinationTypes = new Set([
    'ONE_TIME_ADDRESS', 'VAULT_ACCOUNT', 'EXCHANGE_ACCOUNT', 'INTERNAL_WALLET',
    'EXTERNAL_WALLET', 'CONTRACT', 'FIAT_ACCOUNT', 'NETWORK_CONNECTION',
    'COMPOUND', 'END_USER_WALLET',
  ])

  if (!id) return { valid: false, reason: 'fireblocks-history-transaction-id-missing' }
  if (operation !== 'TRANSFER') return { valid: false, reason: 'fireblocks-history-unsupported-operation' }
  if (sourceType !== 'VAULT_ACCOUNT' || sourceId !== String(vaultAccountId)) {
    return { valid: false, reason: 'fireblocks-history-source-vault-mismatch' }
  }
  if (assetId !== String(usdtAssetId) && assetId !== String(trxAssetId)) {
    return { valid: false, reason: 'fireblocks-history-unsupported-asset' }
  }
  if (amountBaseUnits === null || BigInt(amountBaseUnits) <= 0n) {
    return { valid: false, reason: 'fireblocks-history-amount-invalid' }
  }
  if (!status) return { valid: false, reason: 'fireblocks-history-provider-status-missing' }
  if (!createdAtMs) return { valid: false, reason: 'fireblocks-history-created-at-missing' }
  if (transactionHash && !TXID_PATTERN.test(transactionHash)) {
    return { valid: false, reason: 'fireblocks-history-transaction-hash-invalid' }
  }
  if (!supportedDestinationTypes.has(destinationType)) {
    return { valid: false, reason: 'fireblocks-history-destination-type-unsupported' }
  }
  if (destinationType === 'ONE_TIME_ADDRESS' && !ADDRESS_PATTERN.test(destinationAddress || '')) {
    return { valid: false, reason: 'fireblocks-history-destination-address-invalid' }
  }
  if (destinationType !== 'ONE_TIME_ADDRESS' && !destinationId && !destinationAddress) {
    return { valid: false, reason: 'fireblocks-history-destination-identity-missing' }
  }
  if (destinationType === 'VAULT_ACCOUNT' && !destinationId) {
    return { valid: false, reason: 'fireblocks-history-destination-vault-id-missing' }
  }

  return {
    valid: true,
    entry: {
      providerTransactionId: id,
      assetId,
      assetCode: assetId === String(usdtAssetId) ? 'USDT' : 'TRX',
      amountBaseUnits,
      operation,
      providerStatus: status,
      externalTxId,
      transactionHash,
      sourceType,
      sourceId,
      destinationType,
      destinationId,
      destinationAddress: destinationAddress || null,
      createdAtMs,
      rawSha256: createHash('sha256').update(JSON.stringify(transaction)).digest('hex'),
      terminalNoBroadcast: FINAL_NO_BROADCAST_STATUSES.has(status) && !transactionHash,
    },
  }
}

function rowIdentity(kind, row) {
  return kind + ':' + String(row.idempotency_key || '')
}

/**
 * Reconcile provider history with the application's request ledger. Every app
 * request with a Fireblocks provider ID must appear exactly once and match the
 * exact asset, amount and recipient. Unmatched provider transfers are external
 * outflows and are deducted from the third-party principal pool.
 */
export function reconcileFireblocksOutboundHistory({
  entries = [],
  usdtRequests = [],
  trxRequests = [],
  usdtAssetId,
  trxAssetId,
} = {}) {
  const requests = [
    ...usdtRequests.map((row) => ({ kind: 'USDT', row })),
    ...trxRequests.map((row) => ({ kind: 'TRX', row })),
  ]
  const byExternalId = new Map()
  const byProviderId = new Map()
  for (const item of requests) {
    const key = String(item.row.idempotency_key || '')
    const providerId = String(item.row.provider_transaction_id || '')
    if (key) {
      const values = byExternalId.get(key) || []
      values.push(item)
      byExternalId.set(key, values)
    }
    if (providerId) {
      const values = byProviderId.get(providerId) || []
      values.push(item)
      byProviderId.set(providerId, values)
    }
  }

  const blockers = []
  const seenApplicationRequests = new Set()
  let externalUsdtBaseUnits = 0n
  let externalTrxBaseUnits = 0n
  const digest = createHash('sha256')
  const seenProviderIds = new Set()

  for (const entry of entries) {
    if (seenProviderIds.has(entry.providerTransactionId)) {
      blockers.push('fireblocks-history-duplicate-provider-transaction-id')
      continue
    }
    seenProviderIds.add(entry.providerTransactionId)
    digest.update(entry.providerTransactionId + ':' + entry.rawSha256 + '\n')

    const candidates = [
      ...(entry.externalTxId ? (byExternalId.get(entry.externalTxId) || []) : []),
      ...(byProviderId.get(entry.providerTransactionId) || []),
    ]
    const uniqueCandidates = [...new Map(candidates.map((item) => [rowIdentity(item.kind, item.row), item])).values()]
    if (uniqueCandidates.length > 1) {
      blockers.push('fireblocks-history-application-match-ambiguous')
      continue
    }
    const matched = uniqueCandidates[0]
    if (matched) {
      const row = matched.row
      const expectedAssetId = matched.kind === 'USDT' ? String(usdtAssetId) : String(trxAssetId)
      const amount = String(row.amount_base_units || '')
      if (row.status === 'rejected') {
        blockers.push('fireblocks-history-matches-rejected-application-request')
        continue
      }
      if (entry.assetCode !== matched.kind || entry.assetId !== expectedAssetId
        || !/^[1-9][0-9]{0,77}$/.test(amount)
        || entry.amountBaseUnits !== amount
        || entry.destinationType !== 'ONE_TIME_ADDRESS'
        || entry.destinationAddress !== String(row.recipient_address || '')
        || (row.provider_transaction_id && String(row.provider_transaction_id) !== entry.providerTransactionId)) {
        blockers.push('fireblocks-history-application-transaction-mismatch')
        continue
      }
      seenApplicationRequests.add(rowIdentity(matched.kind, row))
      continue
    }

    // A final Fireblocks rejection with no chain hash is not an asset outflow.
    // Every other provider status remains reserved as an external outflow.
    if (entry.terminalNoBroadcast) continue
    if (entry.assetCode === 'USDT') externalUsdtBaseUnits += BigInt(entry.amountBaseUnits)
    else if (entry.assetCode === 'TRX') externalTrxBaseUnits += BigInt(entry.amountBaseUnits)
    else blockers.push('fireblocks-history-asset-classification-invalid')
  }

  for (const item of requests) {
    const row = item.row
    if (row.status === 'rejected') continue
    if (row.provider_transaction_id && !seenApplicationRequests.has(rowIdentity(item.kind, row))) {
      blockers.push('fireblocks-history-application-transaction-missing')
    }
  }

  return {
    verified: blockers.length === 0,
    blockers: [...new Set(blockers)],
    externalUsdtBaseUnits: externalUsdtBaseUnits.toString(),
    externalTrxBaseUnits: externalTrxBaseUnits.toString(),
    transactionCount: entries.length,
    reconciliationDigest: digest.digest('hex'),
  }
}

function bearerToken(req) {
  const header = req.get('authorization') || ''
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header)
  return match ? match[1] : ''
}

async function readAppWithdrawalLedgers(db, treasuryAddress) {
  const usdt = await db.query(
    'SELECT idempotency_key, provider_transaction_id, recipient_address, amount_base_units::text AS amount_base_units, status ' +
    'FROM ' + SCHEMA + '.treasury_withdrawal_requests WHERE treasury_address=$1',
    [treasuryAddress],
  )
  const trx = await db.query(
    'SELECT idempotency_key, provider_transaction_id, recipient_address, amount_base_units::text AS amount_base_units, status ' +
    'FROM ' + SCHEMA + '.treasury_trx_withdrawal_requests WHERE treasury_address=$1',
    [treasuryAddress],
  )
  return { usdtRequests: usdt.rows, trxRequests: trx.rows }
}

export async function getFireblocksOutboundHistoryStatus({
  env = process.env,
  treasuryAddress = typeof env.TREASURY_ADDRESS === 'string' ? env.TREASURY_ADDRESS.trim() : '',
  now = () => Date.now(),
  maxAgeMs = HISTORY_MAX_AGE_MS,
} = {}) {
  const cfg = fireblocksConfiguration(env)
  const vaultAccountId = cfg.vaultAccountId
  if (!env.DATABASE_URL) return { verified: false, reason: 'fireblocks-vault-outbound-history-not-reconciled' }
  if (!cfg.providerConfigured || !cfg.usdtAssetId || !cfg.trxAssetId
    || !vaultAccountId || !ADDRESS_PATTERN.test(treasuryAddress || '')) {
    return { verified: false, reason: 'fireblocks-vault-outbound-history-not-reconciled' }
  }
  const db = getPool(env)
  if (!db) return { verified: false, reason: 'fireblocks-vault-outbound-history-not-reconciled' }
  try {
    await ensureHistorySchema(db)
    const result = await db.query(
      'SELECT * FROM ' + SCHEMA + '.fireblocks_outbound_history_state WHERE vault_account_id=$1',
      [vaultAccountId],
    )
    if (!result.rows.length) return { verified: false, reason: 'fireblocks-vault-outbound-history-not-reconciled' }
    const row = result.rows[0]
    const checkedAt = row.checked_at ? new Date(row.checked_at).getTime() : 0
    const ageMs = checkedAt > 0 ? now() - checkedAt : null
    const verified = row.status === 'complete'
      && row.treasury_address === treasuryAddress
      && row.usdt_asset_id === cfg.usdtAssetId
      && row.trx_asset_id === cfg.trxAssetId
      && String(row.history_start_ms) === HISTORY_START_MS
      && row.failure_code === null
      && Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= maxAgeMs
    if (!verified) return {
      verified: false,
      reason: 'fireblocks-vault-outbound-history-not-reconciled',
      status: row.status,
      checkedAt: row.checked_at || null,
      ageMs,
    }
    return {
      verified: true,
      reason: null,
      status: 'complete',
      checkedAt: row.checked_at,
      ageMs,
      transactionCount: String(row.transaction_count || '0'),
      externalUsdtBaseUnits: String(row.external_usdt_base_units || '0'),
      externalTrxBaseUnits: String(row.external_trx_base_units || '0'),
      reconciliationDigest: String(row.reconciliation_digest || ''),
      historyStartMs: HISTORY_START_MS,
      historyEndMs: String(row.history_end_ms),
    }
  } catch {
    return { verified: false, reason: 'fireblocks-vault-outbound-history-not-reconciled' }
  }
}

export function createFireblocksOutboundHistoryRouter({
  env = process.env,
  sessionLookup = getWalletAuthSession,
  fireblocksFactory = (currentEnv) => createFireblocksClient(currentEnv),
  now = () => Date.now(),
} = {}) {
  const router = Router()

  async function authenticateOwner(req) {
    const token = bearerToken(req)
    const origin = req.get('origin') || ''
    const expectedOwner = typeof env.TREASURY_OWNER_ADDRESS === 'string' ? env.TREASURY_OWNER_ADDRESS.trim() : ''
    const consoleOwner = typeof env.OWNER_WALLET_ADDRESS === 'string' ? env.OWNER_WALLET_ADDRESS.trim() : ''
    if (!token || !origin || !ADDRESS_PATTERN.test(expectedOwner) || consoleOwner !== expectedOwner) {
      return { ok: false, status: 401, error: 'owner-auth-required' }
    }
    const session = await sessionLookup({
      tokenHash: createHash('sha256').update(token, 'utf8').digest('hex'),
      origin,
    })
    if (!session?.success || !session.session) return { ok: false, status: 401, error: 'invalid-or-expired-session' }
    if (session.session.network !== 'mainnet' || session.session.address !== expectedOwner
      || session.session.origin !== origin) {
      return { ok: false, status: 403, error: 'treasury-owner-only' }
    }
    return { ok: true, ownerAddress: expectedOwner }
  }

  router.get('/fireblocks/outbound-history/status', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const treasuryAddress = typeof env.TREASURY_ADDRESS === 'string' ? env.TREASURY_ADDRESS.trim() : ''
    const status = await getFireblocksOutboundHistoryStatus({ env, treasuryAddress, now })
    return res.json({ success: true, ...status })
  })

  router.post('/fireblocks/outbound-history/sync', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })

    const cfg = fireblocksConfiguration(env)
    const treasuryAddress = typeof env.TREASURY_ADDRESS === 'string' ? env.TREASURY_ADDRESS.trim() : ''
    if (!cfg.providerConfigured || !cfg.usdtAssetId || !cfg.trxAssetId
      || !cfg.vaultAccountId || !ADDRESS_PATTERN.test(treasuryAddress)) {
      return res.status(503).json({ success: false, error: 'fireblocks-outbound-history-configuration-incomplete' })
    }
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })

    let client
    try {
      await ensureHistorySchema(db)
      const fireblocks = fireblocksFactory(env)
      const vault = await fireblocks.getVaultAccount()
      if (String(vault?.id ?? '') !== cfg.vaultAccountId) {
        return res.status(409).json({ success: false, error: 'fireblocks-outbound-history-vault-account-mismatch' })
      }
      const activeAssets = new Set(Array.isArray(vault?.assets)
        ? vault.assets.map((asset) => String(asset?.id || '')).filter(Boolean)
        : [])
      if (!activeAssets.has(cfg.usdtAssetId) || !activeAssets.has(cfg.trxAssetId)) {
        return res.status(409).json({ success: false, error: 'fireblocks-outbound-history-assets-not-active' })
      }

      const existing = await db.query(
        'SELECT * FROM ' + SCHEMA + '.fireblocks_outbound_history_state WHERE vault_account_id=$1',
        [cfg.vaultAccountId],
      )
      let state = existing.rows[0] || null
      if (!state || state.status !== 'scanning') {
        const endMs = String(now())
        const started = await db.query(
          'INSERT INTO ' + SCHEMA + '.fireblocks_outbound_history_state ' +
          '(vault_account_id,treasury_address,history_start_ms,history_end_ms,usdt_asset_id,trx_asset_id,current_run_id,previous_complete_transaction_count,status,next_page_cursor,page_count,transaction_count,' +
          'external_usdt_base_units,external_trx_base_units,reconciliation_digest,failure_code,checked_at,updated_at) ' +
          "VALUES ($1,$2,1,$3,$4,$5,$6,$7,'scanning',NULL,0,0,0,0,NULL,NULL,NULL,now()) " +
          'ON CONFLICT (vault_account_id) DO UPDATE SET treasury_address=EXCLUDED.treasury_address,' +
          'history_start_ms=1,history_end_ms=EXCLUDED.history_end_ms,usdt_asset_id=EXCLUDED.usdt_asset_id,' +
          'trx_asset_id=EXCLUDED.trx_asset_id,current_run_id=EXCLUDED.current_run_id,' +
          'previous_complete_transaction_count=EXCLUDED.previous_complete_transaction_count,' +
          "status='scanning',next_page_cursor=NULL," +
          'page_count=0,transaction_count=0,external_usdt_base_units=0,external_trx_base_units=0,' +
          'reconciliation_digest=NULL,failure_code=NULL,checked_at=NULL,updated_at=now() RETURNING *',
          [cfg.vaultAccountId, treasuryAddress, endMs, cfg.usdtAssetId, cfg.trxAssetId, randomUUID(),
            state?.status === 'complete'
              ? String(state.transaction_count || '0')
              : String(state?.previous_complete_transaction_count || '0')],
        )
        state = started.rows[0]
      } else if (state.treasury_address !== treasuryAddress
        || state.usdt_asset_id !== cfg.usdtAssetId || state.trx_asset_id !== cfg.trxAssetId
        || String(state.history_start_ms) !== HISTORY_START_MS) {
        return res.status(409).json({ success: false, error: 'fireblocks-outbound-history-scan-identity-mismatch' })
      }

      client = await db.connect()
      let cursor = state.next_page_cursor || null
      let pagesThisCall = 0
      let transactionCount = BigInt(String(state.transaction_count || '0'))
      const seenCursors = new Set(cursor ? [cursor] : [])

      while (pagesThisCall < MAX_PAGES_PER_CALL) {
        const page = await fireblocks.getTransactionsPage({
          after: HISTORY_START_MS,
          before: String(state.history_end_ms),
          next: cursor || undefined,
          limit: PAGE_SIZE,
        })
        if (!Array.isArray(page?.transactions)) {
          throw new Error('fireblocks-history-invalid-page')
        }
        const parsedEntries = []
        for (const transaction of page.transactions) {
          const parsed = parseFireblocksOutboundHistoryTransaction(transaction, {
            vaultAccountId: cfg.vaultAccountId,
            usdtAssetId: cfg.usdtAssetId,
            trxAssetId: cfg.trxAssetId,
          })
          if (!parsed.valid) {
            await db.query(
              'UPDATE ' + SCHEMA + '.fireblocks_outbound_history_state SET status=\'blocked\',failure_code=$2,updated_at=now() WHERE vault_account_id=$1',
              [cfg.vaultAccountId, parsed.reason],
            )
            return res.status(409).json({
              success: false,
              status: 'blocked',
              error: parsed.reason,
              pageCount: Number(state.page_count || 0) + pagesThisCall,
              transactionCount: transactionCount.toString(),
            })
          }
          parsedEntries.push(parsed.entry)
        }

        await client.query('BEGIN')
        for (const entry of parsedEntries) {
          await client.query(
            'INSERT INTO ' + SCHEMA + '.fireblocks_outbound_history_entries ' +
            '(provider_transaction_id,vault_account_id,asset_id,asset_code,amount_base_units,operation,provider_status,' +
            'external_tx_id,transaction_hash,source_type,source_id,destination_type,destination_id,destination_address,' +
            'created_at_ms,raw_sha256,terminal_no_broadcast,last_seen_run_id,last_seen_at) ' +
            'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,now()) ' +
            'ON CONFLICT (provider_transaction_id) DO UPDATE SET ' +
            'vault_account_id=EXCLUDED.vault_account_id,asset_id=EXCLUDED.asset_id,asset_code=EXCLUDED.asset_code,' +
            'amount_base_units=EXCLUDED.amount_base_units,operation=EXCLUDED.operation,provider_status=EXCLUDED.provider_status,' +
            'external_tx_id=EXCLUDED.external_tx_id,transaction_hash=EXCLUDED.transaction_hash,' +
            'source_type=EXCLUDED.source_type,source_id=EXCLUDED.source_id,destination_type=EXCLUDED.destination_type,' +
            'destination_id=EXCLUDED.destination_id,destination_address=EXCLUDED.destination_address,' +
            'created_at_ms=EXCLUDED.created_at_ms,raw_sha256=EXCLUDED.raw_sha256,' +
            'terminal_no_broadcast=EXCLUDED.terminal_no_broadcast,last_seen_run_id=EXCLUDED.last_seen_run_id,last_seen_at=now()',
            [
              entry.providerTransactionId, cfg.vaultAccountId, entry.assetId, entry.assetCode,
              entry.amountBaseUnits, entry.operation, entry.providerStatus, entry.externalTxId,
              entry.transactionHash, entry.sourceType, entry.sourceId, entry.destinationType,
              entry.destinationId, entry.destinationAddress, entry.createdAtMs, entry.rawSha256,
              entry.terminalNoBroadcast, state.current_run_id,
            ],
          )
        }
        cursor = page.nextPage || null
        if (cursor && (typeof cursor !== 'string' || cursor.length > 8192 || /[\r\n]/.test(cursor) || seenCursors.has(cursor))) {
          await client.query('ROLLBACK')
          await db.query(
            'UPDATE ' + SCHEMA + '.fireblocks_outbound_history_state SET status=\'blocked\',failure_code=$2,updated_at=now() WHERE vault_account_id=$1',
            [cfg.vaultAccountId, 'fireblocks-history-pagination-cursor-invalid-or-looped'],
          )
          return res.status(409).json({ success: false, status: 'blocked', error: 'fireblocks-history-pagination-cursor-invalid-or-looped' })
        }
        if (cursor) seenCursors.add(cursor)
        transactionCount += BigInt(parsedEntries.length)
        pagesThisCall += 1
        await client.query(
          'UPDATE ' + SCHEMA + '.fireblocks_outbound_history_state ' +
          'SET next_page_cursor=$2,page_count=page_count+1,transaction_count=$3,updated_at=now() WHERE vault_account_id=$1',
          [cfg.vaultAccountId, cursor, transactionCount.toString()],
        )
        await client.query('COMMIT')

        if (!cursor) break
      }

      if (cursor) {
        return res.status(202).json({
          success: true,
          status: 'scanning',
          pagesFetchedThisCall: pagesThisCall,
          totalPagesFetched: Number(state.page_count || 0) + pagesThisCall,
          transactionCount: transactionCount.toString(),
          nextAction: 'Run this same owner-only sync endpoint again to resume the stored Fireblocks pagination cursor.',
          payoutExecutionAuthorized: false,
        })
      }

      const stored = await db.query(
        'SELECT provider_transaction_id,asset_id,asset_code,amount_base_units::text AS amount_base_units,' +
        'operation,provider_status,external_tx_id,transaction_hash,source_type,source_id,destination_type,' +
        'destination_id,destination_address,created_at_ms,raw_sha256,terminal_no_broadcast ' +
        'FROM ' + SCHEMA + '.fireblocks_outbound_history_entries WHERE vault_account_id=$1 AND last_seen_run_id=$2 ORDER BY provider_transaction_id',
        [cfg.vaultAccountId, state.current_run_id],
      )
      const appLedger = await readAppWithdrawalLedgers(db, treasuryAddress)
      const reconciliation = reconcileFireblocksOutboundHistory({
        entries: stored.rows.map((row) => ({
          providerTransactionId: row.provider_transaction_id,
          assetId: row.asset_id,
          assetCode: row.asset_code,
          amountBaseUnits: String(row.amount_base_units),
          operation: row.operation,
          providerStatus: row.provider_status,
          externalTxId: row.external_tx_id,
          transactionHash: row.transaction_hash ? String(row.transaction_hash).trim() : null,
          sourceType: row.source_type,
          sourceId: row.source_id,
          destinationType: row.destination_type,
          destinationId: row.destination_id,
          destinationAddress: row.destination_address,
          createdAtMs: Number(row.created_at_ms),
          rawSha256: row.raw_sha256,
          terminalNoBroadcast: row.terminal_no_broadcast === true,
        })),
        ...appLedger,
        usdtAssetId: cfg.usdtAssetId,
        trxAssetId: cfg.trxAssetId,
      })
      const historyCountRegressed = BigInt(String(state.previous_complete_transaction_count || '0')) > BigInt(stored.rows.length)
      const historyEntryCountMismatch = transactionCount !== BigInt(stored.rows.length)
      const blockers = [
        ...reconciliation.blockers,
        ...(historyCountRegressed ? ['fireblocks-history-entry-count-regressed'] : []),
        ...(historyEntryCountMismatch ? ['fireblocks-history-page-entry-count-mismatch'] : []),
      ]
      const reconciliationVerified = blockers.length === 0
      const status = reconciliationVerified ? 'complete' : 'blocked'
      const failureCode = blockers[0] || null
      await db.query(
        'UPDATE ' + SCHEMA + '.fireblocks_outbound_history_state SET ' +
        'status=$2,next_page_cursor=NULL,transaction_count=$3,' +
        'previous_complete_transaction_count=CASE WHEN $2=\'complete\' THEN $3::bigint ELSE previous_complete_transaction_count END,' +
        'external_usdt_base_units=$4,external_trx_base_units=$5,reconciliation_digest=$6,' +
        'failure_code=$7,checked_at=now(),updated_at=now() WHERE vault_account_id=$1',
        [
          cfg.vaultAccountId, status, String(stored.rows.length),
          reconciliation.externalUsdtBaseUnits, reconciliation.externalTrxBaseUnits,
          reconciliation.reconciliationDigest, failureCode,
        ],
      )
      return res.status(reconciliationVerified ? 200 : 409).json({
        success: reconciliationVerified,
        status,
        transactionCount: reconciliation.transactionCount,
        externalUsdtOutboundBaseUnits: reconciliation.externalUsdtBaseUnits,
        externalTrxOutboundBaseUnits: reconciliation.externalTrxBaseUnits,
        reconciliationDigest: reconciliation.reconciliationDigest,
        blockers,
        checkedAt: new Date(now()).toISOString(),
        payoutExecutionAuthorized: false,
        note: 'This is a read-only Fireblocks transaction-history reconciliation. It does not create, approve, sign, or submit a transfer.',
      })
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {})
      await db.query(
        'UPDATE ' + SCHEMA + '.fireblocks_outbound_history_state ' +
        "SET status='scanning',failure_code=$2,updated_at=now() WHERE vault_account_id=$1",
        [cfg.vaultAccountId, safeText(error?.message, 128) || 'fireblocks-history-sync-failed'],
      ).catch(() => {})
      return res.status(503).json({
        success: false,
        status: 'scanning',
        error: 'fireblocks-outbound-history-sync-unavailable',
        payoutExecutionAuthorized: false,
      })
    } finally {
      client?.release()
    }
  })

  return router
}

export default createFireblocksOutboundHistoryRouter
