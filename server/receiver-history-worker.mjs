import pg from 'pg'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { recordTransferVerification } from './database.mjs'

const { Pool } = pg
const SCHEMA = 'trc20_token_clone'
const NETWORK_HOSTS = Object.freeze({
  mainnet: 'https://api.trongrid.io',
  shasta: 'https://api.shasta.trongrid.io',
  nile: 'https://nile.trongrid.io',
})
const MAX_WALLETS_PER_RUN = 100
const MAX_PAGES_PER_WALLET = 5
const MAX_VERIFICATIONS_PER_RUN = 25
const PAGE_SIZE = 50
const REQUEST_TIMEOUT_MS = 10000
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/

export function makeReceiverEventKey({ transactionId, tokenContract, senderAddress, receiverAddress, amountBaseUnits, timestamp, eventIndex }) {
  const identity = [
    String(transactionId || '').toLowerCase(),
    String(tokenContract || '').toLowerCase(),
    eventIndex === undefined || eventIndex === null ? '' : String(eventIndex),
    String(senderAddress || '').toLowerCase(),
    String(receiverAddress || '').toLowerCase(),
    String(amountBaseUnits || ''),
    String(timestamp || ''),
  ].join('|')
  return createHash('sha256').update(identity).digest('hex')
}

function boundedFingerprint(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && /^[A-Za-z0-9_=-]+$/.test(value)
    ? value
    : null
}

export function normalizeIndexedEvent(item, network, walletAddress) {
  const transactionId = item?.transaction_id || item?.txID
  const tokenContract = item?.token_info?.address || item?.contract_address
  const senderAddress = item?.from
  const receiverAddress = item?.to || walletAddress
  const amountBaseUnits = item?.value === undefined || item?.value === null ? null : String(item.value)
  const timestamp = Number(item?.block_timestamp)
  if (typeof transactionId !== 'string' || !/^[0-9a-f]{64}$/i.test(transactionId)
    || typeof tokenContract !== 'string' || !ADDRESS_PATTERN.test(tokenContract)
    || typeof senderAddress !== 'string' || !ADDRESS_PATTERN.test(senderAddress)
    || typeof receiverAddress !== 'string' || !ADDRESS_PATTERN.test(receiverAddress)
    || !/^[0-9]+$/.test(amountBaseUnits || '') || amountBaseUnits.length > 78
    || !/[1-9]/.test(amountBaseUnits)
    || !Number.isSafeInteger(timestamp) || timestamp <= 0) {
    return null
  }
  const decimals = Number(item?.token_info?.decimals)
  const eventIndex = item?.event_index ?? item?.eventIndex ?? null
  const normalized = {
    network,
    walletAddress,
    transactionId: transactionId.toLowerCase(),
    tokenContract,
    senderAddress,
    receiverAddress,
    amountBaseUnits,
    timestamp,
    tokenName: typeof item?.token_info?.name === 'string' ? item.token_info.name.slice(0, 120) : null,
    tokenSymbol: typeof item?.token_info?.symbol === 'string' ? item.token_info.symbol.slice(0, 32) : null,
    tokenDecimals: Number.isInteger(decimals) && decimals >= 0 && decimals <= 30 ? decimals : null,
    eventIndex: eventIndex === null ? null : String(eventIndex).slice(0, 64),
  }
  normalized.eventKey = makeReceiverEventKey(normalized)
  return normalized
}

async function ensureTables(db) {
  await db.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`)
  // Match the application's existing watchlist schema so a standalone cron
  // process can initialize safely even if it starts before the web service.
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.tracked_wallets (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      network TEXT NOT NULL CHECK (network IN ('mainnet','shasta','nile')),
      wallet_address TEXT NOT NULL,
      display_label TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (network, wallet_address)
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.receiver_history_events (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      network TEXT NOT NULL CHECK (network IN ('mainnet','shasta','nile')),
      wallet_address TEXT NOT NULL,
      event_key CHAR(64) NOT NULL,
      transaction_hash CHAR(64) NOT NULL,
      token_contract TEXT NOT NULL,
      from_address TEXT NOT NULL,
      to_address TEXT NOT NULL,
      amount_base_units NUMERIC(78,0) NOT NULL CHECK (amount_base_units > 0),
      token_name TEXT,
      token_symbol TEXT,
      token_decimals SMALLINT,
      event_index TEXT,
      block_timestamp BIGINT NOT NULL,
      verification_status TEXT NOT NULL DEFAULT 'indexed-candidate-awaiting-solidified-verification'
        CHECK (verification_status IN ('indexed-candidate-awaiting-solidified-verification','verified-on-chain','not-verified','awaiting-solidified-receipt','provider-error')),
      verified_on_chain BOOLEAN NOT NULL DEFAULT FALSE,
      verification_result JSONB,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (network, wallet_address, event_key)
    )
  `)
  await db.query(`ALTER TABLE ${SCHEMA}.receiver_history_events ADD COLUMN IF NOT EXISTS verification_result JSONB`)
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_ttc_receiver_history_wallet_time
      ON ${SCHEMA}.receiver_history_events (network, wallet_address, block_timestamp DESC)
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.receiver_monitor_checkpoints (
      network TEXT NOT NULL CHECK (network IN ('mainnet','shasta','nile')),
      wallet_address TEXT NOT NULL,
      last_success_at TIMESTAMPTZ,
      last_event_timestamp BIGINT,
      last_seen_count INTEGER NOT NULL DEFAULT 0,
      last_error_code TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (network, wallet_address)
    )
  `)
}

async function scanWallet(db, wallet, { fetchImpl = fetch, env = process.env } = {}) {
  const network = wallet.network
  const walletAddress = wallet.wallet_address
  const host = NETWORK_HOSTS[network]
  if (!host || typeof walletAddress !== 'string' || !ADDRESS_PATTERN.test(walletAddress)) {
    return { seen: 0, inserted: 0, error: 'invalid-watch-record' }
  }

  const headers = { accept: 'application/json' }
  if (env.TRONGRID_API_KEY) headers['TRON-PRO-API-KEY'] = env.TRONGRID_API_KEY
  let fingerprint = null
  let seen = 0
  let inserted = 0
  let lastEventTimestamp = null
  try {
    for (let page = 0; page < MAX_PAGES_PER_WALLET; page += 1) {
      const params = new URLSearchParams({
        only_confirmed: 'true',
        only_to: 'true',
        limit: String(PAGE_SIZE),
        order_by: 'block_timestamp,desc',
      })
      if (fingerprint) params.set('fingerprint', fingerprint)
      const response = await fetchImpl(`${host}/v1/accounts/${encodeURIComponent(walletAddress)}/transactions/trc20?${params.toString()}`, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`provider-http-${response.status}`)
      const payload = await response.json()
      if (!Array.isArray(payload?.data)) throw new Error('invalid-provider-payload')
      for (const item of payload.data) {
        const event = normalizeIndexedEvent(item, network, walletAddress)
        if (!event) continue
        seen += 1
        lastEventTimestamp = Math.max(lastEventTimestamp || 0, event.timestamp)
        const result = await db.query(
          `INSERT INTO ${SCHEMA}.receiver_history_events
            (network,wallet_address,event_key,transaction_hash,token_contract,from_address,to_address,
             amount_base_units,token_name,token_symbol,token_decimals,event_index,block_timestamp)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (network,wallet_address,event_key)
           DO UPDATE SET last_seen_at=now()
           RETURNING (xmax = 0) AS inserted`,
          [event.network,event.walletAddress,event.eventKey,event.transactionId,event.tokenContract,
           event.senderAddress,event.receiverAddress,event.amountBaseUnits,event.tokenName,event.tokenSymbol,
           event.tokenDecimals,event.eventIndex,event.timestamp],
        )
        if (result.rows[0]?.inserted === true) inserted += 1
      }
      const next = boundedFingerprint(payload?.meta?.fingerprint)
      if (!next || next === fingerprint || payload.data.length < PAGE_SIZE) break
      fingerprint = next
    }
    await db.query(
      `INSERT INTO ${SCHEMA}.receiver_monitor_checkpoints
        (network,wallet_address,last_success_at,last_event_timestamp,last_seen_count,last_error_code,updated_at)
       VALUES ($1,$2,now(),$3,$4,NULL,now())
       ON CONFLICT (network,wallet_address) DO UPDATE SET
         last_success_at=now(),
         last_event_timestamp=GREATEST(COALESCE(${SCHEMA}.receiver_monitor_checkpoints.last_event_timestamp,0),COALESCE(EXCLUDED.last_event_timestamp,0)),
         last_seen_count=EXCLUDED.last_seen_count,
         last_error_code=NULL,
         updated_at=now()`,
      [network,walletAddress,lastEventTimestamp,seen],
    )
    return { seen, inserted, error: null }
  } catch (error) {
    const code = typeof error?.message === 'string' && /^provider-http-[0-9]{3}$/.test(error.message)
      ? error.message
      : (error?.name === 'TimeoutError' ? 'provider-timeout' : 'scan-failed')
    await db.query(
      `INSERT INTO ${SCHEMA}.receiver_monitor_checkpoints
        (network,wallet_address,last_error_code,updated_at)
       VALUES ($1,$2,$3,now())
       ON CONFLICT (network,wallet_address) DO UPDATE SET last_error_code=EXCLUDED.last_error_code,updated_at=now()`,
      [network,walletAddress,code],
    )
    return { seen, inserted, error: code }
  }
}

function normalizeHexAddress(value) {
  if (typeof value !== 'string') return null
  const hex = value.replace(/^0x/i, '').toLowerCase()
  if (!/^(?:41)?[0-9a-f]{40}$/.test(hex)) return null
  return hex.startsWith('41') ? hex.slice(2) : hex
}

async function verifyPendingCandidates(db, { env, fetchImpl }) {
  const approvedContracts = new Set(
    String(env.TRON_VERIFIED_TOKEN_CONTRACTS || '')
      .split(',')
      .map(normalizeHexAddress)
      .filter(Boolean),
  )
  if (!approvedContracts.size) return { checked: 0, verified: 0, pending: 0, skipped: 'token-allowlist-not-configured' }

  const pending = await db.query(
    `SELECT id,network,transaction_hash,token_contract,from_address,to_address,amount_base_units::text AS amount_base_units
       FROM ${SCHEMA}.receiver_history_events
      WHERE verification_status IN ('indexed-candidate-awaiting-solidified-verification','awaiting-solidified-receipt','provider-error')
      ORDER BY block_timestamp DESC
      LIMIT $1`,
    [MAX_VERIFICATIONS_PER_RUN],
  )
  if (!pending.rows.length) return { checked: 0, verified: 0, pending: 0 }

  const { TronWeb } = await import('tronweb')
  let checked = 0
  let verified = 0
  let stillPending = 0
  for (const row of pending.rows) {
    const host = NETWORK_HOSTS[row.network]
    if (!host) continue
    const tronWeb = new TronWeb({ fullHost: host })
    let contractHex, fromHex, toHex
    try {
      contractHex = normalizeHexAddress(tronWeb.address.toHex(row.token_contract))
      fromHex = tronWeb.address.toHex(row.from_address).replace(/^0x/i, '')
      toHex = tronWeb.address.toHex(row.to_address).replace(/^0x/i, '')
    } catch {
      await db.query(`UPDATE ${SCHEMA}.receiver_history_events SET verification_status='not-verified',verification_result=$2::jsonb,last_seen_at=now() WHERE id=$1`, [row.id, JSON.stringify({ verified: false, reason: 'invalid-indexed-address' })])
      checked += 1
      continue
    }
    if (!contractHex || !approvedContracts.has(contractHex)) continue

    const headers = { 'content-type': 'application/json' }
    if (env.TRONGRID_API_KEY) headers['TRON-PRO-API-KEY'] = env.TRONGRID_API_KEY
    const query = async (path) => {
      const response = await fetchImpl(host + path, {
        method: 'POST',
        headers,
        body: JSON.stringify({ value: row.transaction_hash.trim(), visible: false }),
        signal: AbortSignal.timeout(8000),
      })
      if (!response.ok) throw new Error('solidified-provider-unavailable')
      return response.json()
    }
    checked += 1
    try {
      const transaction = await query('/walletsolidity/gettransactionbyid')
      const receipt = await query('/walletsolidity/gettransactioninfobyid')
      const { verifySolidifiedTrc20Transfer } = await import('./tron-verification.mjs')
      const result = verifySolidifiedTrc20Transfer({
        transaction,
        receipt,
        expectedTxId: row.transaction_hash.trim(),
        tokenContractAddress: contractHex,
        fromAddress: fromHex,
        toAddress: toHex,
        amountSun: row.amount_base_units,
      })
      if (result.verified) {
        const persisted = await recordTransferVerification({
          network: row.network,
          transactionHash: row.transaction_hash.trim(),
          tokenContract: contractHex,
          fromAddress: normalizeHexAddress(fromHex),
          toAddress: normalizeHexAddress(toHex),
          amountBaseUnits: row.amount_base_units,
          status: 'verified-on-chain',
          logIndex: result.logIndex,
          result,
        })
        if (!persisted.persisted) {
          await db.query(`UPDATE ${SCHEMA}.receiver_history_events SET verification_status='provider-error',verification_result=$2::jsonb,last_seen_at=now() WHERE id=$1`, [row.id, JSON.stringify({ verified: false, reason: persisted.reason || 'verification-persistence-failed' })])
          stillPending += 1
          continue
        }
        await db.query(`UPDATE ${SCHEMA}.receiver_history_events SET verification_status='verified-on-chain',verified_on_chain=TRUE,verification_result=$2::jsonb,last_seen_at=now() WHERE id=$1`, [row.id, JSON.stringify(result)])
        verified += 1
      } else if (result.reason === 'solidified-transaction-not-found-or-id-mismatch' || result.reason === 'solidified-receipt-not-found-or-id-mismatch' || result.reason === 'receipt-has-no-solidified-block') {
        await db.query(`UPDATE ${SCHEMA}.receiver_history_events SET verification_status='awaiting-solidified-receipt',verification_result=$2::jsonb,last_seen_at=now() WHERE id=$1`, [row.id, JSON.stringify(result)])
        stillPending += 1
      } else {
        await db.query(`UPDATE ${SCHEMA}.receiver_history_events SET verification_status='not-verified',verification_result=$2::jsonb,last_seen_at=now() WHERE id=$1`, [row.id, JSON.stringify(result)])
      }
    } catch {
      await db.query(`UPDATE ${SCHEMA}.receiver_history_events SET verification_status='provider-error',verification_result=$2::jsonb,last_seen_at=now() WHERE id=$1`, [row.id, JSON.stringify({ verified: false, reason: 'solidified-provider-request-failed' })])
      stillPending += 1
    }
  }
  return { checked, verified, pending: stillPending }
}

export async function runReceiverHistorySweep({ env = process.env, fetchImpl = fetch } = {}) {
  if (env.RECEIVER_HISTORY_WORKER_ENABLED !== 'true') {
    return { enabled: false, scannedWallets: 0, insertedCandidates: 0, failedWallets: 0 }
  }
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required when receiver monitoring is enabled')
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
    max: 2,
    ssl: env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
  })
  try {
    await ensureTables(pool)
    const result = await pool.query(
      `SELECT network,wallet_address FROM ${SCHEMA}.tracked_wallets
       WHERE network = ANY($1::text[])
       ORDER BY created_at ASC LIMIT $2`,
      [Object.keys(NETWORK_HOSTS), MAX_WALLETS_PER_RUN],
    )
    let insertedCandidates = 0
    let failedWallets = 0
    for (const wallet of result.rows) {
      const scan = await scanWallet(pool, wallet, { fetchImpl, env })
      insertedCandidates += scan.inserted
      if (scan.error) failedWallets += 1
    }
    const verification = await verifyPendingCandidates(pool, { env, fetchImpl })
    return {
      enabled: true,
      scannedWallets: result.rows.length,
      insertedCandidates,
      failedWallets,
      verification,
    }
  } finally {
    await pool.end()
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  try {
    const summary = await runReceiverHistorySweep()
    if (!summary.enabled) {
      console.log('Receiver history worker disabled; no addresses scanned.')
    } else {
      console.log('Receiver history sweep complete:', JSON.stringify(summary))
    }
  } catch (error) {
    console.error('Receiver history sweep failed:', error?.message || 'unknown-error')
    process.exitCode = 1
  }
}
