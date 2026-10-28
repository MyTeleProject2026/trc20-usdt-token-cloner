import { createHash } from 'node:crypto'
import { Router } from 'express'
import pg from 'pg'
import { TronWeb } from 'tronweb'
import { getWalletAuthSession, normalizeDatabaseConnectionString, databaseSslConfig } from '../database.mjs'
import { isValidTronAddress } from '../tron-address.mjs'

const { Pool } = pg
const MAINNET_RPC = 'https://api.trongrid.io'
const USDT_MAINNET = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const TXID_PATTERN = /^[0-9a-f]{64}$/i
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{24,128}$/
const SESSION_PATTERN = /^[A-Za-z0-9_-]{43}$/
const ABI = [
  { constant: true, inputs: [{ name: 'owner', type: 'address' }], name: 'balanceOf', outputs: [{ name: 'balance', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { constant: true, inputs: [], name: 'decimals', outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view', type: 'function' },
  { constant: true, inputs: [], name: 'symbol', outputs: [{ name: '', type: 'string' }], stateMutability: 'view', type: 'function' },
  { constant: false, inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }], name: 'transfer', outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable', type: 'function' },
]

let pool
let schemaPromise
function getPool(env) {
  if (pool) return pool
  if (!env.DATABASE_URL) return null
  const connectionString = normalizeDatabaseConnectionString(env.DATABASE_URL)
  pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    max: 3,
    ssl: databaseSslConfig(connectionString, env),
  })
  pool.on('error', (error) => console.error('Treasury withdrawal database error:', error?.code || 'unknown'))
  return pool
}

async function ensureSchema(db) {
  if (!schemaPromise) {
    schemaPromise = db.query('CREATE SCHEMA IF NOT EXISTS trc20_token_clone').then(() => db.query(`
      CREATE TABLE IF NOT EXISTS trc20_token_clone.treasury_withdrawal_requests (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        owner_address TEXT NOT NULL,
        treasury_address TEXT NOT NULL,
        recipient_address TEXT NOT NULL,
        token_contract TEXT NOT NULL,
        amount_base_units NUMERIC(78,0) NOT NULL CHECK (amount_base_units > 0),
        status TEXT NOT NULL CHECK (status IN ('broadcasting','broadcast-accepted','broadcast-unknown','confirmed','failed','rejected')),
        transaction_hash CHAR(64),
        failure_code TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)).then(async () => {
      await db.query('ALTER TABLE trc20_token_clone.treasury_withdrawal_requests DROP CONSTRAINT IF EXISTS treasury_withdrawal_requests_status_check')
      await db.query("ALTER TABLE trc20_token_clone.treasury_withdrawal_requests ADD CONSTRAINT treasury_withdrawal_requests_status_check CHECK (status IN ('broadcasting','broadcast-accepted','broadcast-unknown','confirmed','failed','rejected'))")
      await db.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_ttc_treasury_withdrawal_tx_hash ON trc20_token_clone.treasury_withdrawal_requests (transaction_hash) WHERE transaction_hash IS NOT NULL")
    }).catch((error) => { schemaPromise = null; throw error })
  }
  await schemaPromise
}

function parsePositiveDecimal(value, decimals = 6) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  if (fraction.length > decimals) return null
  const units = BigInt(whole) * (10n ** BigInt(decimals)) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0')
  return units > 0n ? units : null
}

function readLimit(value) {
  const units = typeof value === 'string' ? parsePositiveDecimal(value, 6) : null
  return units !== null && units < (1n << 256n) ? units : null
}

function normalizedHex(value) {
  return typeof value === 'string' ? value.replace(/^0x/i, '').toLowerCase() : ''
}

function addressHex(tronWeb, address) {
  try {
    return normalizedHex(tronWeb.address.toHex(address))
  } catch {
    return ''
  }
}

/** Validate the complete unsigned/signed transaction intent before it is broadcast. */
export function assertTreasuryPayoutTransactionIntent(tronWeb, transaction, {
  treasuryAddress,
  recipientAddress,
  amountBaseUnits,
  tokenContract = USDT_MAINNET,
} = {}) {
  if (!tronWeb || typeof tronWeb !== 'object'
    || !isValidTronAddress(treasuryAddress) || !isValidTronAddress(recipientAddress)
    || !isValidTronAddress(tokenContract)
    || !ADDRESS_PATTERN.test(treasuryAddress) || !ADDRESS_PATTERN.test(recipientAddress)
    || !ADDRESS_PATTERN.test(tokenContract)
    || typeof amountBaseUnits !== 'string' || !/^[1-9][0-9]{0,77}$/.test(amountBaseUnits)
    || BigInt(amountBaseUnits) >= (1n << 256n)
    || typeof transaction?.txID !== 'string' || !TXID_PATTERN.test(transaction.txID)
    || !Array.isArray(transaction?.raw_data?.contract)
    || transaction.raw_data.contract.length !== 1) {
    throw new Error('Treasury transfer intent is malformed.')
  }
  if (transaction.raw_data_hex !== undefined) {
    const rawDataHex = typeof transaction.raw_data_hex === 'string'
      ? transaction.raw_data_hex.replace(/^0x/i, '') : ''
    if (!/^(?:[0-9a-f]{2})+$/i.test(rawDataHex)
      || createHash('sha256').update(Buffer.from(rawDataHex, 'hex')).digest('hex') !== transaction.txID.toLowerCase()) {
      throw new Error('Treasury transaction ID does not match its raw transaction payload.')
    }
  }
  const operation = transaction.raw_data.contract[0]
  const value = operation?.parameter?.value
  const ownerHex = addressHex(tronWeb, treasuryAddress)
  const recipientHex = addressHex(tronWeb, recipientAddress)
  const contractHex = addressHex(tronWeb, tokenContract)
  if (operation?.type !== 'TriggerSmartContract' || !ownerHex || !recipientHex || !contractHex
    || normalizedHex(value?.owner_address) !== ownerHex
    || normalizedHex(value?.contract_address) !== contractHex) {
    throw new Error('Treasury transaction sender or token contract does not match the approved intent.')
  }
  const recipientBytes = recipientHex.startsWith('41') ? recipientHex.slice(2) : recipientHex
  if (!/^[0-9a-f]{40}$/.test(recipientBytes)) {
    throw new Error('Treasury transaction recipient could not be encoded safely.')
  }
  const expectedData = 'a9059cbb'
    + recipientBytes.padStart(64, '0')
    + BigInt(amountBaseUnits).toString(16).padStart(64, '0')
  if (normalizedHex(value?.data) !== expectedData) {
    throw new Error('Treasury transaction recipient or amount differs from the reviewed request.')
  }
  return true
}

/** A receipt is authoritative only when its confirmed transaction matches this saved payout exactly. */
export function classifyConfirmedPayoutReceipt(tronWeb, record, confirmedTransaction, transactionInfo) {
  const expectedTxid = String(record?.transaction_hash || '').trim().toLowerCase()
  const observedTxid = String(confirmedTransaction?.txID || confirmedTransaction?.txid || '').toLowerCase()
  if (!expectedTxid || !TXID_PATTERN.test(expectedTxid) || observedTxid !== expectedTxid) return null
  try {
    assertTreasuryPayoutTransactionIntent(tronWeb, confirmedTransaction, {
      treasuryAddress: record.treasury_address,
      recipientAddress: record.recipient_address,
      amountBaseUnits: String(record.amount_base_units),
      tokenContract: record.token_contract,
    })
  } catch {
    return null
  }
  const results = [
    confirmedTransaction?.ret?.[0]?.contractRet,
    transactionInfo?.receipt?.result,
    transactionInfo?.result,
  ].filter((value) => typeof value === 'string' && value.length > 0).map((value) => value.toUpperCase())
  if (results.some((value) => ['FAILED', 'OUT_OF_ENERGY', 'REVERT', 'REVERTED'].includes(value))) return 'failed'
  if (results.some((value) => value === 'SUCCESS')) return 'confirmed'
  return null
}

function bearerToken(req) {
  const value = req.get('authorization') || ''
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(value)
  return match ? match[1] : ''
}

function safeStatus(row) {
  return {
    idempotencyKey: row.idempotency_key,
    network: 'mainnet',
    asset: 'USDT',
    tokenContract: USDT_MAINNET,
    treasuryAddress: row.treasury_address,
    recipientAddress: row.recipient_address,
    amountBaseUnits: String(row.amount_base_units),
    status: row.status,
    ...(row.transaction_hash ? { transactionHash: String(row.transaction_hash).trim() } : {}),
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

/**
 * Owner-only treasury-backed withdrawals. The owner signs in with the existing
 * wallet-auth challenge; the server signs transfers from a separate treasury
 * key. The signer is disabled unless explicitly opted in. This route never
 * mints tokens and only transfers USDT already held by the configured treasury.
 */
export function createTreasuryWithdrawalsRouter({
  env = process.env,
  sessionLookup = getWalletAuthSession,
  tronWebFactory = (privateKey) => new TronWeb({ fullHost: MAINNET_RPC, ...(privateKey ? { privateKey } : {}) }),
  readOnlyTronWebFactory = () => new TronWeb({ fullHost: MAINNET_RPC }),
  now = () => new Date(),
} = {}) {
  const router = Router()

  async function authenticateOwner(req) {
    const origin = req.get('origin')
    const token = bearerToken(req)
    const expectedOwner = typeof env.TREASURY_OWNER_ADDRESS === 'string' ? env.TREASURY_OWNER_ADDRESS.trim() : ''
    if (!token || !origin || !ADDRESS_PATTERN.test(expectedOwner)) return { ok: false, status: 401, error: 'owner-auth-required' }
    const result = await sessionLookup({
      tokenHash: createHash('sha256').update(token, 'utf8').digest('hex'),
      origin,
    })
    if (!result?.success || !result.session) return { ok: false, status: 401, error: 'invalid-or-expired-session' }
    if (result.session.network !== 'mainnet' || result.session.address !== expectedOwner || result.session.origin !== origin) {
      return { ok: false, status: 403, error: 'treasury-owner-only' }
    }
    return { ok: true, ownerAddress: expectedOwner }
  }

  function configuration() {
    const required = ['DATABASE_URL', 'TREASURY_OWNER_ADDRESS', 'TREASURY_ADDRESS', 'TREASURY_PRIVATE_KEY', 'TREASURY_MAX_PAYOUT_USDT', 'TREASURY_DAILY_LIMIT_USDT', 'TREASURY_FEE_LIMIT_SUN', 'TREASURY_MIN_TRX_RESERVE']
    const missing = required.filter((key) => typeof env[key] !== 'string' || !env[key].trim())
    const enabled = env.TREASURY_WITHDRAWALS_ENABLED === 'true'
      && env.TREASURY_SIGNER_MODE === 'env-hot-wallet'
      && missing.length === 0
      && ADDRESS_PATTERN.test(env.TREASURY_OWNER_ADDRESS || '')
      && ADDRESS_PATTERN.test(env.TREASURY_ADDRESS || '')
      && Boolean(readLimit(env.TREASURY_MAX_PAYOUT_USDT))
      && Boolean(readLimit(env.TREASURY_DAILY_LIMIT_USDT))
      && Boolean(readLimit(env.TREASURY_MIN_TRX_RESERVE))
      && /^\d+$/.test(env.TREASURY_FEE_LIMIT_SUN || '')
      && Number(env.TREASURY_FEE_LIMIT_SUN) >= 1
      && Number.isSafeInteger(Number(env.TREASURY_FEE_LIMIT_SUN))
      && Number(env.TREASURY_FEE_LIMIT_SUN) <= 100_000_000
    return { enabled, missing, signerMode: env.TREASURY_SIGNER_MODE === 'env-hot-wallet' ? 'env-hot-wallet' : 'not-configured' }
  }

  router.get('/withdrawals/readiness', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const config = configuration()
    const db = getPool(env)
    let databaseReady = false
    if (db) {
      try { await ensureSchema(db); await db.query('SELECT 1'); databaseReady = true } catch {}
    }
    // Treasury identity is separate from the owner identity. Verify the secret key
    // derives exactly the explicitly configured public treasury address.
    let treasuryAddress = null
    let signerMatchesConfiguredAddress = false
    if (config.enabled) {
      try {
        const tronWeb = tronWebFactory(env.TREASURY_PRIVATE_KEY.trim())
        treasuryAddress = tronWeb.address.fromPrivateKey(env.TREASURY_PRIVATE_KEY.trim())
        signerMatchesConfiguredAddress = ADDRESS_PATTERN.test(treasuryAddress)
          && treasuryAddress === env.TREASURY_ADDRESS.trim()
      } catch {}
    }
    let usdtBalance = null
    let treasuryTrxBalanceSun = null
    const minimumTrxReserveSun = readLimit(env.TREASURY_MIN_TRX_RESERVE)
    if (databaseReady && config.enabled && signerMatchesConfiguredAddress) {
      try {
        const tronWeb = tronWebFactory(env.TREASURY_PRIVATE_KEY.trim())
        const contract = await tronWeb.contract(ABI).at(USDT_MAINNET)
        const [decimals, symbol, rawUsdtBalance, rawTrxBalance] = await Promise.all([
          contract.decimals().call(),
          contract.symbol().call(),
          contract.balanceOf(treasuryAddress).call(),
          tronWeb.trx.getBalance(treasuryAddress),
        ])
        const usdtText = String(rawUsdtBalance)
        const trxText = String(rawTrxBalance)
        if (Number(decimals) === 6 && String(symbol).toUpperCase() === 'USDT'
          && /^(0|[1-9][0-9]*)$/.test(usdtText)
          && /^(0|[1-9][0-9]*)$/.test(trxText)) {
          usdtBalance = usdtText
          treasuryTrxBalanceSun = trxText
        }
      } catch {}
    }
    const nativeFeeReserveSatisfied = treasuryTrxBalanceSun !== null
      && minimumTrxReserveSun !== null
      && BigInt(treasuryTrxBalanceSun) >= minimumTrxReserveSun
    return res.json({
      success: true,
      network: 'mainnet',
      asset: 'USDT',
      tokenContract: USDT_MAINNET,
      withdrawalsEnabled: config.enabled && databaseReady && signerMatchesConfiguredAddress
        && usdtBalance !== null && nativeFeeReserveSatisfied,
      configuration: { enabled: config.enabled, missing: config.missing, signerMode: config.signerMode },
      databaseReady,
      treasuryAddress,
      signerMatchesConfiguredAddress,
      treasuryUsdtBalanceBaseUnits: usdtBalance,
      treasuryTrxBalanceSun,
      minimumTrxReserveSun: minimumTrxReserveSun?.toString() || null,
      nativeFeeReserveSatisfied,
      limitations: [
        'This is a treasury-funded withdrawal service, not a token minting mechanism.',
        'A broadcast-accepted response is not proof of confirmation; verify the transaction receipt on TRON.',
        'An exchange deposit may require additional confirmations and may be subject to the exchange own policies.',
        'An environment hot-wallet signer carries custody risk; use a dedicated low-balance treasury and independent security review.',
      ],
    })
  })

  router.post('/withdrawals', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const config = configuration()
    if (!config.enabled) return res.status(503).json({ success: false, error: 'treasury-withdrawals-disabled', missing: config.missing })
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).some((key) => !['recipientAddress', 'amountUsdt', 'idempotencyKey'].includes(key))
      || !ADDRESS_PATTERN.test(body.recipientAddress || '')
      || !IDEMPOTENCY_PATTERN.test(body.idempotencyKey || '')
      || typeof body.amountUsdt !== 'string') {
      return res.status(400).json({ success: false, error: 'invalid-withdrawal-request' })
    }
    const amount = parsePositiveDecimal(body.amountUsdt)
    const maxPayout = readLimit(env.TREASURY_MAX_PAYOUT_USDT)
    const dailyLimit = readLimit(env.TREASURY_DAILY_LIMIT_USDT)
    if (!amount || amount >= (1n << 256n) || !maxPayout || !dailyLimit || amount > maxPayout || amount > dailyLimit) {
      return res.status(400).json({ success: false, error: 'amount-outside-configured-limits' })
    }
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const tronWeb = tronWebFactory(env.TREASURY_PRIVATE_KEY.trim())
      const treasuryAddress = tronWeb.address.fromPrivateKey(env.TREASURY_PRIVATE_KEY.trim())
      if (!tronWeb.isAddress(body.recipientAddress) || !isValidTronAddress(body.recipientAddress)
        || !ADDRESS_PATTERN.test(treasuryAddress)
        || treasuryAddress !== env.TREASURY_ADDRESS.trim()
        || treasuryAddress === body.recipientAddress) {
        return res.status(503).json({ success: false, error: 'invalid-treasury-or-recipient' })
      }
      const configuredFeeLimit = Number(env.TREASURY_FEE_LIMIT_SUN)
      const minimumTrxReserveSun = readLimit(env.TREASURY_MIN_TRX_RESERVE)
      const contract = await tronWeb.contract(ABI).at(USDT_MAINNET)
      const [decimals, symbol, balanceValue, trxBalanceValue] = await Promise.all([
        contract.decimals().call(), contract.symbol().call(), contract.balanceOf(treasuryAddress).call(),
        tronWeb.trx.getBalance(treasuryAddress),
      ])
      if (Number(decimals) !== 6 || String(symbol).toUpperCase() !== 'USDT') {
        return res.status(503).json({ success: false, error: 'official-token-metadata-check-failed' })
      }
      const balanceText = String(balanceValue)
      const trxBalanceText = String(trxBalanceValue)
      if (!/^(0|[1-9][0-9]*)$/.test(balanceText) || !/^(0|[1-9][0-9]*)$/.test(trxBalanceText) || !minimumTrxReserveSun) {
        return res.status(503).json({ success: false, error: 'treasury-balance-read-invalid' })
      }
      const balance = BigInt(balanceText)
      if (balance < amount) return res.status(409).json({ success: false, error: 'treasury-usdt-insufficient', treasuryUsdtBalanceBaseUnits: balance.toString() })
      if (BigInt(trxBalanceText) < minimumTrxReserveSun) {
        return res.status(409).json({ success: false, error: 'treasury-trx-fee-reserve-insufficient', treasuryTrxBalanceSun: trxBalanceText, minimumTrxReserveSun: minimumTrxReserveSun.toString() })
      }

      const client = await db.connect()
      let reservation
      try {
        await client.query('BEGIN')
        await client.query("SELECT pg_advisory_xact_lock(hashtext('tron-token-studio-treasury-withdrawals-mainnet'))")
        const existing = await client.query('SELECT * FROM trc20_token_clone.treasury_withdrawal_requests WHERE idempotency_key = $1 FOR UPDATE', [body.idempotencyKey])
        if (existing.rows.length) {
          const existingRow = existing.rows[0]
          await client.query('COMMIT')
          if (existingRow.owner_address !== auth.ownerAddress
            || existingRow.recipient_address !== body.recipientAddress
            || String(existingRow.amount_base_units) !== amount.toString()
            || existingRow.treasury_address !== treasuryAddress
            || existingRow.token_contract !== USDT_MAINNET) {
            return res.status(409).json({ success: false, error: 'idempotency-key-conflict', note: 'This key already identifies a different withdrawal. Look up the original request; do not reuse the key for different parameters.' })
          }
          return res.status(200).json({ success: true, duplicate: true, withdrawal: safeStatus(existingRow), note: 'Existing request returned; no second transfer was broadcast.' })
        }
        const spent = await client.query(`
          SELECT COALESCE(SUM(amount_base_units), 0)::text AS amount
            FROM trc20_token_clone.treasury_withdrawal_requests
           WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
             AND status <> 'rejected'
        `)
        const alreadyReserved = BigInt(spent.rows[0]?.amount || '0')
        if (alreadyReserved + amount > dailyLimit) {
          await client.query('ROLLBACK')
          return res.status(429).json({ success: false, error: 'treasury-daily-limit-exceeded' })
        }
        // Pending/ambiguous transactions reserve principal until their on-chain result
        // is reconciled. This deliberately favors safety over temporary payout availability.
        const activeReservations = await client.query(`
          SELECT COALESCE(SUM(amount_base_units), 0)::text AS amount
            FROM trc20_token_clone.treasury_withdrawal_requests
           WHERE status IN ('broadcasting','broadcast-accepted','broadcast-unknown')
        `)
        const outstanding = BigInt(activeReservations.rows[0]?.amount || '0')
        if (outstanding + amount > balance) {
          await client.query('ROLLBACK')
          return res.status(409).json({ success: false, error: 'treasury-usdt-reserved-for-pending-withdrawals', availableForNewWithdrawalBaseUnits: (balance > outstanding ? (balance - outstanding).toString() : '0') })
        }
        const inserted = await client.query(`
          INSERT INTO trc20_token_clone.treasury_withdrawal_requests
            (idempotency_key, owner_address, treasury_address, recipient_address, token_contract, amount_base_units, status)
          VALUES ($1,$2,$3,$4,$5,$6,'broadcasting')
          RETURNING *
        `, [body.idempotencyKey, auth.ownerAddress, treasuryAddress, body.recipientAddress, USDT_MAINNET, amount.toString()])
        reservation = inserted.rows[0]
        await client.query('COMMIT')
      } catch (error) {
        try { await client.query('ROLLBACK') } catch {}
        if (error?.code === '23505') {
          const existing = await db.query('SELECT * FROM trc20_token_clone.treasury_withdrawal_requests WHERE idempotency_key = $1', [body.idempotencyKey])
          if (existing.rows.length) {
            const existingRow = existing.rows[0]
            if (existingRow.owner_address !== auth.ownerAddress
              || existingRow.recipient_address !== body.recipientAddress
              || String(existingRow.amount_base_units) !== amount.toString()
              || existingRow.treasury_address !== treasuryAddress
              || existingRow.token_contract !== USDT_MAINNET) {
              return res.status(409).json({ success: false, error: 'idempotency-key-conflict' })
            }
            return res.status(200).json({ success: true, duplicate: true, withdrawal: safeStatus(existingRow), note: 'Existing request returned; no second transfer was broadcast.' })
          }
        }
        throw error
      } finally {
        client.release()
      }

      let unsignedTransaction
      let signedTransaction
      let txid = ''
      // Build, validate, and sign before persisting the transaction ID. Nothing is
      // broadcast until the exact signed transaction's ID is durably recorded.
      try {
        const built = await tronWeb.transactionBuilder.triggerSmartContract(
          USDT_MAINNET,
          'transfer(address,uint256)',
          { feeLimit: configuredFeeLimit, callValue: 0 },
          [
            { type: 'address', value: body.recipientAddress },
            { type: 'uint256', value: amount.toString() },
          ],
          treasuryAddress,
        )
        if (built?.result?.result !== true || !built?.transaction) {
          throw new Error('transaction-build-failed')
        }
        unsignedTransaction = built.transaction
        assertTreasuryPayoutTransactionIntent(tronWeb, unsignedTransaction, {
          treasuryAddress,
          recipientAddress: body.recipientAddress,
          amountBaseUnits: amount.toString(),
        })
        signedTransaction = await tronWeb.trx.sign(unsignedTransaction, env.TREASURY_PRIVATE_KEY.trim())
        if (!signedTransaction || !Array.isArray(signedTransaction.signature)
          || signedTransaction.signature.length < 1
          || signedTransaction.txID !== unsignedTransaction.txID) {
          throw new Error('transaction-signing-failed')
        }
        assertTreasuryPayoutTransactionIntent(tronWeb, signedTransaction, {
          treasuryAddress,
          recipientAddress: body.recipientAddress,
          amountBaseUnits: amount.toString(),
        })
        txid = unsignedTransaction.txID
      } catch {
        await db.query(`UPDATE trc20_token_clone.treasury_withdrawal_requests
          SET status='rejected', failure_code='transaction-build-or-sign-failed', updated_at=now()
          WHERE id=$1`, [reservation.id]).catch(() => {})
        return res.status(503).json({ success: false, error: 'treasury-transaction-build-or-sign-failed', note: 'No transaction was broadcast.' })
      }

      // Save the locally calculated transaction ID before network submission so an
      // ambiguous timeout can be reconciled by the exact same hash without resending.
      const storedTx = await db.query(`UPDATE trc20_token_clone.treasury_withdrawal_requests
        SET transaction_hash=$2, updated_at=now()
        WHERE id=$1 AND status='broadcasting' RETURNING id`, [reservation.id, txid])
      if (!storedTx.rows.length) {
        return res.status(503).json({ success: false, error: 'transaction-id-not-persisted', note: 'No broadcast was attempted.' })
      }

      let broadcast
      try {
        broadcast = await tronWeb.trx.sendRawTransaction(signedTransaction)
      } catch {
        await db.query(`UPDATE trc20_token_clone.treasury_withdrawal_requests
          SET status='broadcast-unknown', failure_code='broadcast-outcome-unknown', updated_at=now()
          WHERE id=$1`, [reservation.id]).catch(() => {})
        return res.status(202).json({
          success: false,
          status: 'broadcast-unknown',
          idempotencyKey: body.idempotencyKey,
          transactionHash: txid,
          error: 'broadcast-outcome-unknown',
          note: 'The network outcome is ambiguous. Reconcile this transaction hash; do not submit a replacement payout.',
        })
      }
      const reportedTxid = typeof broadcast?.txid === 'string' ? broadcast.txid
        : typeof broadcast?.txID === 'string' ? broadcast.txID : ''
      if (broadcast?.result !== true || (reportedTxid && reportedTxid.toLowerCase() !== txid.toLowerCase())) {
        await db.query(`UPDATE trc20_token_clone.treasury_withdrawal_requests
          SET status='broadcast-unknown', failure_code=$2, updated_at=now()
          WHERE id=$1`, [reservation.id, reportedTxid && reportedTxid.toLowerCase() !== txid.toLowerCase()
            ? 'broadcast-response-id-mismatch' : 'broadcast-outcome-unknown']).catch(() => {})
        return res.status(202).json({
          success: false,
          status: 'broadcast-unknown',
          idempotencyKey: body.idempotencyKey,
          transactionHash: txid,
          error: 'broadcast-outcome-unknown',
          note: 'The node response did not safely confirm acceptance. The signed transaction ID is recorded for reconciliation; do not submit a replacement.',
        })
      }
      const updated = await db.query(`UPDATE trc20_token_clone.treasury_withdrawal_requests
        SET status='broadcast-accepted', updated_at=now()
        WHERE id=$1 RETURNING *`, [reservation.id])
      return res.status(202).json({
        success: true,
        status: 'broadcast-accepted',
        withdrawal: safeStatus(updated.rows[0]),
        note: 'The node accepted the broadcast response. This is not confirmation and does not guarantee that an exchange credited the deposit.',
      })

    } catch {
      return res.status(503).json({ success: false, error: 'treasury-withdrawal-unavailable' })
    }
  })

  router.get('/withdrawals/:idempotencyKey', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    if (!IDEMPOTENCY_PATTERN.test(req.params.idempotencyKey || '')) return res.status(400).json({ success: false, error: 'invalid-idempotency-key' })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const result = await db.query('SELECT * FROM trc20_token_clone.treasury_withdrawal_requests WHERE idempotency_key = $1 AND owner_address = $2', [req.params.idempotencyKey, auth.ownerAddress])
      if (!result.rows.length) return res.status(404).json({ success: false, error: 'withdrawal-not-found' })
      let row = result.rows[0]
      if (row.transaction_hash) {
        try {
          const readOnlyTronWeb = readOnlyTronWebFactory()
          const txid = String(row.transaction_hash).trim()
          const [confirmed, info] = await Promise.all([
            readOnlyTronWeb.trx.getConfirmedTransaction(txid),
            readOnlyTronWeb.trx.getTransactionInfo(txid),
          ])
          const outcome = classifyConfirmedPayoutReceipt(readOnlyTronWeb, row, confirmed, info)
          if (outcome && outcome !== row.status) {
            const updated = await db.query(`UPDATE trc20_token_clone.treasury_withdrawal_requests
              SET status=$2, failure_code=NULL, updated_at=now()
              WHERE id=$1 RETURNING *`, [row.id, outcome])
            if (updated.rows.length) row = updated.rows[0]
          }
        } catch {
          // Provider failures are not evidence of failure or confirmation.
        }
      }
      return res.json({
        success: true,
        withdrawal: safeStatus(row),
        receiptVerified: row.status === 'confirmed' || row.status === 'failed',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'treasury-withdrawal-unavailable' })
    }
  })

  return router
}

export { parsePositiveDecimal }

export default createTreasuryWithdrawalsRouter
