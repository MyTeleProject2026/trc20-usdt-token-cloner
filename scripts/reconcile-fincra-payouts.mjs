#!/usr/bin/env node
import pg from 'pg'
import { TronWeb } from 'tronweb'
import { pathToFileURL } from 'node:url'
import { databaseSslConfig, normalizeDatabaseConnectionString } from '../server/database.mjs'
import { verifyFincraUsdtTrc20Evidence } from '../server/routes/fincra-payouts.mjs'

const { Pool } = pg
const DEFAULT_BATCH_SIZE = 50
const MAX_BATCH_SIZE = 200

function readBatchSize(value) {
  if (value === undefined || value === '') return DEFAULT_BATCH_SIZE
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_BATCH_SIZE) {
    throw new Error('FINCRA_RECONCILE_BATCH_SIZE must be an integer from 1 to 200.')
  }
  return parsed
}

export async function reconcileFincraPayouts({
  db,
  tronWeb,
  limit = DEFAULT_BATCH_SIZE,
  verifyEvidence = verifyFincraUsdtTrc20Evidence,
} = {}) {
  if (!db || typeof db.query !== 'function') throw new Error('A database client is required.')
  if (typeof tronWeb?.trx?.getConfirmedTransaction !== 'function'
    || typeof tronWeb?.trx?.getTransactionInfo !== 'function') {
    throw new Error('A Tatum-backed TRON client with confirmed transaction and receipt reads is required.')
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH_SIZE) {
    throw new Error('Reconciliation batch size is outside the allowed range.')
  }
  const pending = await db.query(
    'SELECT id, customer_reference, owner_address, recipient_address, amount_base_units::text AS amount_base_units, status, transaction_hash FROM trc20_token_clone.fincra_usdt_trc20_payouts WHERE status=$1 AND transaction_hash IS NOT NULL ORDER BY updated_at ASC, id ASC LIMIT $2',
    ['provider-successful-awaiting-chain', limit],
  )
  const withoutHash = await db.query(
    'SELECT count(*)::text AS count FROM trc20_token_clone.fincra_usdt_trc20_payouts WHERE status=$1 AND transaction_hash IS NULL',
    ['provider-successful-awaiting-chain'],
  )
  const summary = {
    scanned: pending.rows.length,
    confirmed: 0,
    failed: 0,
    pending: 0,
    errors: 0,
    awaitingProviderTransactionHash: Number(withoutHash.rows[0]?.count || 0),
  }
  for (const row of pending.rows) {
    const txid = typeof row.transaction_hash === 'string' ? row.transaction_hash.trim() : ''
    if (!/^[0-9a-f]{64}$/i.test(txid)) {
      summary.pending += 1
      continue
    }
    try {
      const [transaction, transactionInfo] = await Promise.all([
        tronWeb.trx.getConfirmedTransaction(txid).catch(() => null),
        tronWeb.trx.getTransactionInfo(txid).catch(() => null),
      ])
      const evidence = verifyEvidence(tronWeb, {
        transaction,
        transactionInfo,
        transactionHash: txid,
        recipientAddress: row.recipient_address,
        amountBaseUnits: String(row.amount_base_units),
      })
      if (!evidence?.verified || !['confirmed', 'failed'].includes(evidence.status)) {
        summary.pending += 1
        continue
      }
      const nextStatus = evidence.status === 'confirmed' ? 'chain-confirmed' : 'chain-failed'
      const failureCode = nextStatus === 'chain-failed'
        ? String(evidence.reason || 'confirmed-transaction-failed').slice(0, 120)
        : null
      const updated = await db.query(
        'UPDATE trc20_token_clone.fincra_usdt_trc20_payouts SET status=$2, failure_code=$3, updated_at=now() WHERE id=$1 AND status=$4 RETURNING id',
        [row.id, nextStatus, failureCode, 'provider-successful-awaiting-chain'],
      )
      if (updated.rows.length) summary[nextStatus === 'chain-confirmed' ? 'confirmed' : 'failed'] += 1
      else summary.pending += 1
    } catch {
      summary.errors += 1
    }
  }
  return summary
}

export async function runFincraPayoutReconciliation({
  env = process.env,
  createPool = (options) => new Pool(options),
  tronWebFactory = (apiKey) => new TronWeb({
    fullHost: 'https://tron-mainnet.gateway.tatum.io',
    headers: { 'x-api-key': apiKey },
  }),
} = {}) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required.')
  if (!env.TATUM_API_KEY) throw new Error('TATUM_API_KEY is required.')
  const connectionString = normalizeDatabaseConnectionString(env.DATABASE_URL)
  const db = createPool({
    connectionString,
    connectionTimeoutMillis: 5000,
    max: 2,
    ssl: databaseSslConfig(connectionString, env),
  })
  try {
    return await reconcileFincraPayouts({
      db,
      tronWeb: tronWebFactory(env.TATUM_API_KEY),
      limit: readBatchSize(env.FINCRA_RECONCILE_BATCH_SIZE),
    })
  } finally {
    await db.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const summary = await runFincraPayoutReconciliation()
    console.log(JSON.stringify({ success: true, ...summary }))
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Fincra payout reconciliation failed.')
    process.exitCode = 1
  }
}
