import { createHash } from 'node:crypto'
import { Router } from 'express'
import pg from 'pg'
import {
  getWalletAuthSession,
  normalizeDatabaseConnectionString,
  databaseSslConfig,
} from '../database.mjs'
import { createSponsorFundingReader } from '../sponsor-funding.mjs'
import { isValidTronAddress } from '../tron-address.mjs'
import { parseSponsorDirectUsdtAmount, verifySponsorDirectMainnetTransfer } from './sponsor-direct-payouts.mjs'
import { resolveOwnerTreasuryFundingAddress } from './owner-treasury.mjs'

const { Pool } = pg
const SCHEMA = 'trc20_token_clone'
const OFFICIAL_MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const TX_ID = /^[0-9a-f]{64}$/i

let pool

function clean(value, max = 256) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, private')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Vary', 'Authorization, Origin')
}

function getPool(env) {
  if (pool) return pool
  if (!clean(env.DATABASE_URL, 4096)) return null
  const connectionString = normalizeDatabaseConnectionString(env.DATABASE_URL)
  pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    max: 3,
    ssl: databaseSslConfig(connectionString, env),
  })
  pool.on('error', (error) => console.error('Owner treasury funding ledger database error:', error?.code || 'unknown'))
  return pool
}

async function ensureSchema(db) {
  await db.query('CREATE SCHEMA IF NOT EXISTS ' + SCHEMA)
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.owner_treasury_verified_inflows (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      network TEXT NOT NULL CHECK (network = 'mainnet'),
      transaction_hash CHAR(64) NOT NULL,
      log_index INTEGER NOT NULL CHECK (log_index >= 0),
      token_contract TEXT NOT NULL CHECK (token_contract = '${OFFICIAL_MAINNET_USDT}'),
      from_address TEXT NOT NULL,
      treasury_address TEXT NOT NULL,
      amount_base_units NUMERIC(78,0) NOT NULL CHECK (amount_base_units > 0),
      block_number BIGINT NOT NULL CHECK (block_number > 0),
      verified_by_owner_address TEXT NOT NULL,
      verification_source TEXT NOT NULL,
      verified_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (transaction_hash, log_index)
    )
  `)
  await db.query(
    'CREATE INDEX IF NOT EXISTS owner_treasury_verified_inflows_created_idx ON ' +
    SCHEMA + '.owner_treasury_verified_inflows (created_at DESC)'
  )
  // Keep the same minimal payout table shape used by the sponsor-direct router.
  // This makes reservation accounting safe even before the sponsor UI is opened.
  await db.query(
    'CREATE TABLE IF NOT EXISTS ' + SCHEMA + '.sponsor_direct_payouts (' +
    'id UUID PRIMARY KEY, idempotency_key UUID NOT NULL UNIQUE, requester_address TEXT NOT NULL, ' +
    'sponsor_address TEXT, recipient_address TEXT NOT NULL, token_contract TEXT NOT NULL, ' +
    'amount_base_units NUMERIC(78,0) NOT NULL CHECK (amount_base_units > 0), ' +
    'minimum_policy_blocked BOOLEAN NOT NULL DEFAULT FALSE, ' +
    'status TEXT NOT NULL DEFAULT \'requested\' CHECK (status IN ' +
    '(\'requested\',\'prepared\',\'broadcasting\',\'submitted\',\'outcome-unknown\',\'broadcast-rejected\',\'confirmed\',\'failed\',\'manual-review\',\'cancelled\',\'expired\')), ' +
    'unsigned_transaction JSONB, signed_transaction JSONB, transaction_hash CHAR(64), ' +
    'failure_code TEXT, expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), ' +
    'updated_at TIMESTAMPTZ NOT NULL DEFAULT now())'
  )
  await db.query(
    'ALTER TABLE ' + SCHEMA + '.sponsor_direct_payouts ADD COLUMN IF NOT EXISTS minimum_policy_blocked BOOLEAN NOT NULL DEFAULT FALSE'
  )
  await db.query(
    'UPDATE ' + SCHEMA + '.sponsor_direct_payouts SET minimum_policy_blocked=TRUE WHERE amount_base_units < 1000000000::numeric AND minimum_policy_blocked=FALSE'
  )
  await db.query(
    `DO $ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sponsor_direct_payouts_minimum_amount_check' AND conrelid='${SCHEMA}.sponsor_direct_payouts'::regclass) THEN ` +
    'ALTER TABLE ' + SCHEMA + '.sponsor_direct_payouts ADD CONSTRAINT sponsor_direct_payouts_minimum_amount_check CHECK (amount_base_units >= 1000000000::numeric OR minimum_policy_blocked=TRUE) NOT VALID; END IF; END $'
  )
  await db.query(
    'CREATE INDEX IF NOT EXISTS sponsor_direct_payouts_sponsor_status_idx ON ' +
    SCHEMA + '.sponsor_direct_payouts (sponsor_address, status, created_at DESC)'
  )
}

function ownerAddress(env) {
  return clean(env.TREASURY_OWNER_ADDRESS || env.OWNER_WALLET_ADDRESS, 64)
}

function fundingAddress(env) {
  return clean(resolveOwnerTreasuryFundingAddress(env), 64)
}

async function authorizeOwner(req, env, getSession, now, isValidAddress) {
  const address = ownerAddress(env)
  if (!address || !isValidAddress(address)) return { ok: false, status: 503, error: 'treasury-owner-not-configured' }
  const origin = clean(req.headers?.origin, 512)
  try {
    const parsed = new URL(origin)
    if (parsed.protocol !== 'https:' || parsed.origin !== origin) {
      return { ok: false, status: 401, error: 'owner-session-required' }
    }
  } catch {
    return { ok: false, status: 401, error: 'owner-session-required' }
  }
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(clean(req.headers?.authorization, 4096))
  if (!match) return { ok: false, status: 401, error: 'owner-session-required' }
  let lookup
  try {
    lookup = await getSession({ tokenHash: digest(match[1]), origin, nowMs: now() })
  } catch {
    lookup = null
  }
  if (lookup?.success !== true) return { ok: false, status: 503, error: 'owner-session-storage-unavailable' }
  const session = lookup.session
  if (!session || session.network !== 'mainnet' || session.origin !== origin) {
    return { ok: false, status: 401, error: 'owner-session-invalid-or-expired' }
  }
  if (session.address !== address) return { ok: false, status: 403, error: 'owner-wallet-not-authorized' }
  return { ok: true, address, origin }
}

export function calculateTreasuryAvailableBaseUnits(balanceBaseUnits, reservedBaseUnits) {
  const valid = (value) => /^(0|[1-9][0-9]*)$/.test(String(value))
  if (!valid(balanceBaseUnits) || !valid(reservedBaseUnits)) {
    throw new Error('Invalid treasury balance reservation values.')
  }
  const balance = BigInt(balanceBaseUnits)
  const reserved = BigInt(reservedBaseUnits)
  return (balance > reserved ? balance - reserved : 0n).toString()
}

export function createOwnerTreasuryFundingLedgerRouter({
  env = process.env,
  getSession = getWalletAuthSession,
  getDatabase = () => getPool(env),
  readFunding = null,
  verifyTransfer = verifySponsorDirectMainnetTransfer,
  isValidAddress = isValidTronAddress,
  now = () => Date.now(),
} = {}) {
  const router = Router()
  const treasuryAddress = fundingAddress(env)
  const readFundingStatus = readFunding || createSponsorFundingReader({
    env: { ...env, SPONSOR_MAINNET_ADDRESS: treasuryAddress },
  })

  async function ownerContext(req, res) {
    noStore(res)
    const auth = await authorizeOwner(req, env, getSession, now, isValidAddress)
    if (!auth.ok) {
      res.status(auth.status).json({ success: false, error: auth.error, submissionEnabled: false })
      return null
    }
    if (!treasuryAddress || !isValidAddress(treasuryAddress)) {
      res.status(503).json({
        success: false,
        error: 'treasury-funding-address-invalid',
        requiredEnvironment: ['TREASURY_MAINNET_ADDRESS', 'SPONSOR_MAINNET_ADDRESS'],
        submissionEnabled: false,
      })
      return null
    }
    return auth
  }

  router.get('/funding-ledger', async (req, res) => {
    const auth = await ownerContext(req, res)
    if (!auth) return
    if (req.query?.network !== 'mainnet') {
      return res.status(400).json({ success: false, error: 'mainnet-required', submissionEnabled: false })
    }
    const db = getDatabase()
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured', submissionEnabled: false })

    try {
      await ensureSchema(db)
      const [funding, inflows, total, reservations] = await Promise.all([
        readFundingStatus('mainnet', { refresh: true }),
        db.query(
          'SELECT transaction_hash, log_index, from_address, treasury_address, ' +
          'amount_base_units::text AS amount_base_units, block_number, verified_at ' +
          'FROM ' + SCHEMA + '.owner_treasury_verified_inflows ' +
          'WHERE network=\'mainnet\' AND treasury_address=$1 ORDER BY created_at DESC LIMIT 25',
          [treasuryAddress],
        ),
        db.query(
          'SELECT COALESCE(SUM(amount_base_units),0)::text AS total ' +
          'FROM ' + SCHEMA + '.owner_treasury_verified_inflows ' +
          'WHERE network=\'mainnet\' AND treasury_address=$1',
          [treasuryAddress],
        ),
        db.query(
          'SELECT COALESCE(SUM(amount_base_units),0)::text AS reserved ' +
          'FROM ' + SCHEMA + '.sponsor_direct_payouts WHERE sponsor_address=$1 AND (' +
          '(status=\'requested\' AND (expires_at IS NULL OR expires_at > now())) OR ' +
          '(status=\'prepared\' AND (expires_at IS NULL OR expires_at > now())) OR ' +
          'status IN (\'broadcasting\',\'submitted\',\'outcome-unknown\',\'manual-review\'))',
          [treasuryAddress],
        ),
      ])
      const token = Array.isArray(funding?.tokens)
        ? funding.tokens.find((item) => item?.asset === 'USDT' && item?.tokenContract === OFFICIAL_MAINNET_USDT)
        : null
      const balanceValid = funding?.onChainBalanceRead === true
        && funding.network === 'mainnet'
        && funding.sponsorAddress === treasuryAddress
        && token?.status === 'verified'
        && token.decimals === 6
        && /^(0|[1-9][0-9]*)$/.test(String(token.balanceBaseUnits))
      const trxValid = funding?.native?.status === 'verified'
        && /^(0|[1-9][0-9]*)$/.test(String(funding.native.balanceSun))
      if (!balanceValid) {
        return res.status(503).json({
          success: false,
          error: 'treasury-on-chain-balance-unavailable',
          message: 'The exact configured Mainnet treasury balance could not be verified. No funding availability is reported.',
          submissionEnabled: false,
        })
      }
      const balanceBaseUnits = String(token.balanceBaseUnits)
      const reservedBaseUnits = String(reservations.rows?.[0]?.reserved ?? '0')
      const totalVerifiedInboundBaseUnits = String(total.rows?.[0]?.total ?? '0')
      if (![reservedBaseUnits, totalVerifiedInboundBaseUnits].every((value) => /^(0|[1-9][0-9]*)$/.test(value))) {
        throw new Error('Treasury accounting values are invalid.')
      }
      const availableBaseUnits = calculateTreasuryAvailableBaseUnits(balanceBaseUnits, reservedBaseUnits)
      return res.json({
        success: true,
        status: 'verified-mainnet-treasury-funding-ledger',
        network: 'mainnet',
        treasuryAddress,
        tokenContract: OFFICIAL_MAINNET_USDT,
        decimals: 6,
        onChainBalanceBaseUnits: balanceBaseUnits,
        reservedBaseUnits,
        availableBaseUnits,
        totalVerifiedInboundBaseUnits,
        native: trxValid
          ? { status: 'verified', balanceSun: String(funding.native.balanceSun), balanceTRX: funding.native.balanceTRX }
          : { status: 'unavailable' },
        entries: (inflows.rows || []).map((row) => ({
          transactionHash: String(row.transaction_hash || '').trim().toLowerCase(),
          logIndex: Number(row.log_index),
          fromAddress: row.from_address,
          treasuryAddress: row.treasury_address,
          amountBaseUnits: String(row.amount_base_units),
          blockNumber: Number(row.block_number),
          verifiedAt: row.verified_at ? new Date(row.verified_at).toISOString() : null,
          verificationStatus: 'solidified-mainnet-usdt-transfer-verified',
        })),
        availableForPayout: BigInt(availableBaseUnits) > 0n,
        fundingVerified: true,
        payoutSubmissionEnabled: false,
        limitations: [
          'Incoming ledger entries are created only from a solidified TRON Mainnet transaction and the exact official USDT Transfer event.',
          'Spendable capacity is the live on-chain USDT balance minus active sponsor-direct payout reservations.',
          'A recorded inflow is not proof of service revenue, donor identity, or source-of-funds compliance.',
          'This ledger does not sign, authorize, or broadcast outgoing transfers. The treasury wallet must separately be approved as a sponsor and sign each exact payout.',
          'TRX or delegated Energy/Bandwidth is still required for network fees; a USDT balance alone is not fee coverage.',
        ],
      })
    } catch {
      return res.status(503).json({
        success: false,
        error: 'treasury-funding-ledger-unavailable',
        message: 'Treasury ledger or reservation accounting could not be verified. No available balance is asserted.',
        submissionEnabled: false,
      })
    }
  })

  router.post('/funding-ledger/deposits/verify', async (req, res) => {
    const auth = await ownerContext(req, res)
    if (!auth) return
    const transactionHash = clean(req.body?.transactionHash, 64).toLowerCase()
    const fromAddress = clean(req.body?.fromAddress, 64)
    let amountBaseUnits
    try {
      if (!TX_ID.test(transactionHash)) throw new Error('invalid-transaction-hash')
      if (!isValidAddress(fromAddress) || fromAddress === treasuryAddress) throw new Error('invalid-external-sender')
      if (req.body?.network !== undefined && req.body.network !== 'mainnet') throw new Error('mainnet-required')
      amountBaseUnits = parseSponsorDirectUsdtAmount(req.body?.amount)
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'invalid-deposit-details',
        credited: false,
      })
    }
    const db = getDatabase()
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured', credited: false })

    let verification
    try {
      verification = await verifyTransfer(env, {
        transactionHash,
        from: fromAddress,
        to: treasuryAddress,
        amountBaseUnits,
      })
    } catch {
      return res.status(503).json({
        success: false,
        error: 'mainnet-verification-provider-unavailable',
        message: 'The solidified Mainnet receipt could not be checked. No ledger credit was recorded.',
        credited: false,
      })
    }
    if (verification?.verified !== true
      || String(verification.transactionHash || verification.txId || '').toLowerCase() !== transactionHash
      || verification.contract !== OFFICIAL_MAINNET_USDT
      || verification.from !== fromAddress
      || verification.to !== treasuryAddress
      || String(verification.amountBaseUnits ?? '') !== amountBaseUnits
      || !Number.isSafeInteger(Number(verification.blockNumber)) || Number(verification.blockNumber) <= 0
      || !Number.isSafeInteger(Number(verification.logIndex)) || Number(verification.logIndex) < 0) {
      return res.status(409).json({
        success: false,
        error: verification?.status || 'solidified-deposit-not-verified',
        message: 'The supplied transaction is not yet a verified exact USDT deposit to this treasury address. No ledger credit was recorded.',
        credited: false,
      })
    }

    try {
      await ensureSchema(db)
      const verifiedAt = new Date(now()).toISOString()
      const evidence = {
        source: 'Tatum SolidityNode transaction body and exact official USDT Transfer event',
        network: 'mainnet',
        transactionHash,
        logIndex: Number(verification.logIndex),
        blockNumber: Number(verification.blockNumber),
        tokenContract: OFFICIAL_MAINNET_USDT,
        fromAddress,
        treasuryAddress,
        amountBaseUnits,
      }
      const inserted = await db.query(
        'INSERT INTO ' + SCHEMA + '.owner_treasury_verified_inflows (' +
        'network, transaction_hash, log_index, token_contract, from_address, treasury_address, ' +
        'amount_base_units, block_number, verified_by_owner_address, verification_source, verified_at) ' +
        'VALUES (\'mainnet\',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ' +
        'ON CONFLICT (transaction_hash, log_index) DO NOTHING RETURNING id',
        [
          transactionHash,
          Number(verification.logIndex),
          OFFICIAL_MAINNET_USDT,
          fromAddress,
          treasuryAddress,
          amountBaseUnits,
          Number(verification.blockNumber),
          auth.address,
          'Tatum solidified Mainnet transaction body and exact official USDT Transfer event',
          verifiedAt,
        ],
      )
      if (!inserted.rowCount) {
        const existing = await db.query(
          'SELECT transaction_hash, log_index, from_address, treasury_address, ' +
          'amount_base_units::text AS amount_base_units, block_number ' +
          'FROM ' + SCHEMA + '.owner_treasury_verified_inflows ' +
          'WHERE transaction_hash=$1 AND log_index=$2',
          [transactionHash, Number(verification.logIndex)],
        )
        const row = existing.rows?.[0]
        const same = row
          && String(row.transaction_hash || '').trim().toLowerCase() === transactionHash
          && Number(row.log_index) === Number(verification.logIndex)
          && row.from_address === fromAddress
          && row.treasury_address === treasuryAddress
          && String(row.amount_base_units) === amountBaseUnits
          && Number(row.block_number) === Number(verification.blockNumber)
        return same
          ? res.status(200).json({ success: true, credited: true, duplicate: true, entry: evidence, payoutSubmissionEnabled: false })
          : res.status(409).json({ success: false, error: 'deposit-event-conflict', credited: false })
      }
      return res.status(201).json({
        success: true,
        credited: true,
        duplicate: false,
        entry: evidence,
        note: 'A verified incoming Mainnet USDT transfer was recorded. Refresh the funding ledger for the current balance and payout reservations.',
        payoutSubmissionEnabled: false,
      })
    } catch {
      return res.status(503).json({
        success: false,
        error: 'treasury-ledger-write-failed',
        message: 'The transaction was verified, but the ledger write did not complete. Refresh before retrying; the unique transaction/log key prevents duplicate credit.',
        credited: false,
      })
    }
  })

  return router
}

export default createOwnerTreasuryFundingLedgerRouter
