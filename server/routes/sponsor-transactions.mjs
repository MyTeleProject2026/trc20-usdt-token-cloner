import { createHash, timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import pg from 'pg'
import { normalizeDatabaseConnectionString, databaseSslConfig } from '../database.mjs'
import { createSponsorTransactionEngine } from '../sponsor-transaction-engine.mjs'

const { Pool } = pg
const SCHEMA = 'trc20_token_clone'
const IDEMPOTENCY = /^[A-Za-z0-9._:-]{24,128}$/
const CONFIRMATION = 'CONFIRM TRON MAINNET SPONSOR TRANSACTION'
let pool
let schemaPromise

function database(env) {
  if (pool) return pool
  if (!env.DATABASE_URL) return null
  const connectionString = normalizeDatabaseConnectionString(env.DATABASE_URL)
  pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, max: 3, ssl: databaseSslConfig(connectionString, env) })
  pool.on('error', (error) => console.error('Sponsor transaction ledger database error:', error?.code || 'unknown'))
  return pool
}
async function ensureSchema(db) {
  if (!schemaPromise) schemaPromise = db.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.sponsor_chain_operations (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      idempotency_key_hash CHAR(64) NOT NULL UNIQUE,
      request_hash CHAR(64) NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('stake','delegate')),
      resource TEXT NOT NULL CHECK (resource IN ('ENERGY','BANDWIDTH')),
      amount_sun NUMERIC(21,0) NOT NULL CHECK (amount_sun > 0),
      sponsor_address TEXT NOT NULL,
      owner_address TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('reserved','broadcast-unknown','submitted','confirmed','failed')),
      transaction_id CHAR(64),
      result_code TEXT,
      confirmation_block BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `).catch((error) => { schemaPromise = null; throw error })
  await schemaPromise
}
function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, private')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Vary', 'Authorization, Origin')
}
function authorized(req, env) {
  const expected = env.SPONSOR_ADMIN_TOKEN
  const supplied = req.get?.('authorization')?.replace(/^Bearer\s+/i, '') || ''
  if (typeof expected !== 'string' || expected.length < 32 || supplied.length !== expected.length || !supplied) return false
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
}
function sha(value) { return createHash('sha256').update(value).digest('hex') }

export function createSponsorTransactionRouter({ env = process.env, getDatabase = () => database(env), engine = createSponsorTransactionEngine({ env }) } = {}) {
  const router = Router()
  router.post('/sponsor/transaction/execute', async (req, res) => {
    noStore(res)
    if (!authorized(req, env)) return res.status(401).json({ success: false, error: 'unauthorized', signed: false, broadcast: false })
    const { operation, amountSun, resource, idempotencyKey, confirmPhrase } = req.body || {}
    const sponsorAddress = env.SPONSOR_MAINNET_ADDRESS
    const ownerAddress = env.TRON_OWNER_ADDRESS || env.TRON_OWNER_WALLET_ADDRESS
    if (!['stake','delegate'].includes(operation) || !['ENERGY','BANDWIDTH'].includes(resource)
      || typeof amountSun !== 'string' || !/^[1-9][0-9]{0,20}$/.test(amountSun)
      || typeof idempotencyKey !== 'string' || !IDEMPOTENCY.test(idempotencyKey)
      || confirmPhrase !== CONFIRMATION
      || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(sponsorAddress || '')
      || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(ownerAddress || '')
      || sponsorAddress === ownerAddress) {
      return res.status(400).json({ success: false, error: 'invalid-or-unconfirmed-sponsor-operation', signed: false, broadcast: false })
    }
    const db = getDatabase()
    if (!db) return res.status(503).json({ success: false, error: 'durable-idempotency-storage-required', signed: false, broadcast: false })
    try {
      await ensureSchema(db)
      const keyHash = sha(idempotencyKey)
      const requestHash = sha(JSON.stringify({ operation, amountSun, resource, sponsorAddress, ownerAddress }))
      const reserved = await db.query(
        'INSERT INTO ' + SCHEMA + '.sponsor_chain_operations ' +
        '(idempotency_key_hash,request_hash,operation,resource,amount_sun,sponsor_address,owner_address,status) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,\'reserved\') ON CONFLICT (idempotency_key_hash) DO NOTHING RETURNING id',
        [keyHash, requestHash, operation, resource, amountSun, sponsorAddress, ownerAddress],
      )
      if (!reserved.rowCount) {
        const prior = await db.query('SELECT request_hash,status,transaction_id,result_code,confirmation_block FROM ' + SCHEMA + '.sponsor_chain_operations WHERE idempotency_key_hash=$1', [keyHash])
        const row = prior.rows[0]
        if (!row || row.request_hash !== requestHash) return res.status(409).json({ success: false, error: 'idempotency-key-reused-with-different-intent' })
        return res.status(409).json({ success: false, error: 'operation-already-reserved-or-submitted', operationStatus: row.status, transactionId: row.transaction_id, resultCode: row.result_code, confirmationBlock: row.confirmation_block, retryAllowed: false })
      }
      const result = await engine.execute({ operation, amountSun, resource, ownerAddress, confirmPhrase })
      const status = result.broadcast ? (result.solidified ? 'confirmed' : 'broadcast-unknown') : 'failed'
      await db.query(
        'UPDATE ' + SCHEMA + '.sponsor_chain_operations SET status=$2,transaction_id=$3,result_code=$4,confirmation_block=$5,updated_at=now() WHERE idempotency_key_hash=$1',
        [keyHash, status, result.txid || null, result.status || 'unknown', result.blockNumber || null],
      )
      return res.status(result.success ? 200 : result.broadcast ? 202 : 422).json({
        success: result.success,
        operationStatus: status,
        transactionId: result.txid || null,
        confirmationBlock: result.blockNumber || null,
        resultCode: result.status,
        sponsorAddress,
        ownerAddress: operation === 'delegate' ? ownerAddress : undefined,
        operation,
        resource,
        amountSun,
        signed: result.signed === true,
        broadcast: result.broadcast === true,
        solidified: result.solidified === true,
        retryAllowed: false,
      })
    } catch {
      return res.status(503).json({ success: false, error: 'sponsor-transaction-storage-or-execution-failed', retryAllowed: false })
    }
  })
  return router
}
