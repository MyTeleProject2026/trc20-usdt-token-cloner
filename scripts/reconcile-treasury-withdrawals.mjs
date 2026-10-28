#!/usr/bin/env node
import pg from 'pg'
import { TronWeb } from 'tronweb'
import { databaseSslConfig, normalizeDatabaseConnectionString } from '../server/database.mjs'
import {
  verifyTreasuryTransferEvidence,
} from '../server/routes/treasury-withdrawals.mjs'

const { Pool } = pg
const MAINNET_RPC = 'https://api.trongrid.io'
const DEFAULT_BATCH_SIZE = 50
const MAX_BATCH_SIZE = 200

function readBatchSize(value) {
  if (value === undefined || value === '') return DEFAULT_BATCH_SIZE
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_BATCH_SIZE) {
    throw new Error('TREASURY_RECONCILE_BATCH_SIZE must be an integer from 1 to 200.')
  }
  return parsed
}

/**
 * Verify stored, already-broadcast treasury withdrawal hashes against TRON's
 * confirmed transaction body and receipt. This worker is read-only with respect
 * to the chain: it never signs, broadcasts, retries, or invents a transaction.
 * A payout is finalized in the database only after the independent verifier
 * confirms the exact official-USDT transfer event or a confirmed failed receipt.
 */
export async function reconcileTreasuryWithdrawals({
  db,
  tronWeb,
  limit = DEFAULT_BATCH_SIZE,
  verifyEvidence = verifyTreasuryTransferEvidence,
} = {}) {
  if (!db || typeof db.query !== 'function') throw new Error('A database client is required.')
  if (typeof tronWeb?.trx?.getConfirmedTransaction !== 'function'
    || typeof tronWeb?.trx?.getTransactionInfo !== 'function') {
    throw new Error('A TRON client with confirmed transaction and receipt reads is required.')
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH_SIZE) {
    throw new Error('Reconciliation batch size is outside the allowed range.')
  }

  const pending = await db.query(`
    SELECT id, idempotency_key, treasury_address, recipient_address, amount_base_units,
           status, transaction_hash
      FROM trc20_token_clone.treasury_withdrawal_requests
     WHERE status IN ('broadcast-accepted','broadcast-unknown')
       AND transaction_hash IS NOT NULL
     ORDER BY updated_at ASC, id ASC
     LIMIT $1
  `, [limit])

  const summary = {
    scanned: pending.rows.length,
    confirmed: 0,
    failed: 0,
    pending: 0,
    errors: 0,
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
        treasuryAddress: row.treasury_address,
        recipientAddress: row.recipient_address,
        amountBaseUnits: String(row.amount_base_units),
      })

      if (!evidence?.verified || !['confirmed', 'failed'].includes(evidence.status)) {
        summary.pending += 1
        continue
      }

      const nextStatus = evidence.status
      const failureCode = nextStatus === 'failed'
        ? String(evidence.reason || 'confirmed-transaction-failed').slice(0, 120)
        : null
      const updated = await db.query(`
        UPDATE trc20_token_clone.treasury_withdrawal_requests
           SET status = $2, failure_code = $3, updated_at = now()
         WHERE id = $1
           AND status IN ('broadcast-accepted','broadcast-unknown')
         RETURNING id
      `, [row.id, nextStatus, failureCode])

      // Another verifier may have finalized the row first; count only our
      // successful transition and never overwrite a terminal status.
      if (updated.rows.length) summary[nextStatus] += 1
      else summary.pending += 1
    } catch {
      // Keep the request's reserved amount untouched when a provider/database
      // error makes its chain outcome uncertain. Do not expose RPC internals.
      summary.errors += 1
    }
  }

  return summary
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required.')
  }
  const batchSize = readBatchSize(process.env.TREASURY_RECONCILE_BATCH_SIZE)
  const connectionString = normalizeDatabaseConnectionString(process.env.DATABASE_URL)
  const db = new Pool({
    connectionString,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
    max: 2,
    ssl: databaseSslConfig(connectionString),
  })
  db.on('error', (error) => console.error('Treasury reconciliation database error:', error?.code || 'unknown'))

  try {
    // The API creates this table when the treasury withdrawal feature is first
    // accessed. Do not auto-create a partial schema in a worker against the
    // wrong database; fail clearly if the API migration has not run.
    await db.query('SELECT 1 FROM trc20_token_clone.treasury_withdrawal_requests LIMIT 0')
    const tronWeb = new TronWeb({ fullHost: MAINNET_RPC })
    const summary = await reconcileTreasuryWithdrawals({ db, tronWeb, limit: batchSize })
    process.stdout.write(JSON.stringify({ success: summary.errors === 0, network: 'mainnet', summary }) + '\n')
    if (summary.errors > 0) process.exitCode = 1
  } finally {
    await db.end()
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  main().catch(() => {
    console.error('Treasury reconciliation did not complete. Keep unresolved payouts reserved and investigate the database/provider configuration.')
    process.exitCode = 1
  })
}
