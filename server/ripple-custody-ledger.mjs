import { randomUUID } from 'node:crypto'
import { getDatabasePool, initializeDatabase } from './database.mjs'

const SCHEMA = 'trc20_token_clone'
const ACCOUNTS = SCHEMA + '.restricted_trx_credit_accounts'
const ENTRIES = SCHEMA + '.restricted_trx_credit_entries'
const MAX_UINT256 = (1n << 256n) - 1n

export function validateRestrictedTrxCreditAllocation(input = {}) {
  const customerId = typeof input.customerId === 'string' ? input.customerId.trim() : ''
  const amountSun = typeof input.amountSun === 'string' ? input.amountSun : ''
  const idempotencyKey = typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : ''
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(customerId)) return { valid: false, error: 'invalid-customer-id' }
  if (!/^[1-9][0-9]{0,77}$/.test(amountSun)) return { valid: false, error: 'invalid-amount-sun' }
  try { if (BigInt(amountSun) > MAX_UINT256) return { valid: false, error: 'amount-overflow' } } catch { return { valid: false, error: 'invalid-amount-sun' } }
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) return { valid: false, error: 'invalid-idempotency-key' }
  if (reason.length < 4 || reason.length > 500) return { valid: false, error: 'reason-required' }
  return { valid: true, customerId, amountSun, idempotencyKey, reason }
}

let schemaPromise
async function ensureSchema(db) {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await db.query(
        'CREATE TABLE IF NOT EXISTS ' + ACCOUNTS + ' (' +
        'customer_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT \'active\' CHECK (status IN (\'active\',\'locked\')),' +
        'created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())'
      )
      await db.query(
        'CREATE TABLE IF NOT EXISTS ' + ENTRIES + ' (' +
        'id UUID PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES ' + ACCOUNTS + '(customer_id),' +
        'asset_label TEXT NOT NULL DEFAULT \'TRX-denominated-internal-credit\' CHECK (asset_label = \'TRX-denominated-internal-credit\'),' +
        'network_label TEXT NOT NULL DEFAULT \'internal-ledger\' CHECK (network_label = \'internal-ledger\'),' +
        'entry_type TEXT NOT NULL CHECK (entry_type IN (\'allocation\')),' +
        'amount_sun NUMERIC(78,0) NOT NULL CHECK (amount_sun > 0), delta_sun NUMERIC(78,0) NOT NULL CHECK (delta_sun > 0),' +
        'idempotency_key TEXT NOT NULL, actor_address TEXT NOT NULL, reason TEXT NOT NULL,' +
        'created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (customer_id, idempotency_key))'
      )
      await db.query('CREATE INDEX IF NOT EXISTS restricted_trx_credit_entries_customer_idx ON ' + ENTRIES + ' (customer_id, created_at DESC)')
      await db.query(
        'CREATE OR REPLACE FUNCTION ' + SCHEMA + '.reject_restricted_trx_credit_mutation() RETURNS trigger LANGUAGE plpgsql AS ' +
        '\'BEGIN RAISE EXCEPTION \'\'restricted TRX credit entries are append-only\'\'; RETURN NULL; END;\''
      )
      await db.query('DROP TRIGGER IF EXISTS restricted_trx_credit_entries_immutable ON ' + ENTRIES)
      await db.query('CREATE TRIGGER restricted_trx_credit_entries_immutable BEFORE UPDATE OR DELETE ON ' + ENTRIES +
        ' FOR EACH ROW EXECUTE FUNCTION ' + SCHEMA + '.reject_restricted_trx_credit_mutation()')
    })().catch((error) => { schemaPromise = null; throw error })
  }
  await schemaPromise
}

export async function getRestrictedTrxCreditAccount(customerId) {
  if (typeof customerId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(customerId)) throw new TypeError('invalid-customer-id')
  const db = getDatabasePool()
  if (!db) return { success: false, error: 'database-not-configured' }
  await initializeDatabase()
  await ensureSchema(db)
  const result = await db.query(
    'SELECT a.customer_id, a.status, a.created_at, a.updated_at, COALESCE(SUM(e.delta_sun),0)::text AS balance_sun, COUNT(e.id)::text AS entry_count ' +
    'FROM ' + ACCOUNTS + ' a LEFT JOIN ' + ENTRIES + ' e ON e.customer_id=a.customer_id WHERE a.customer_id=$1 GROUP BY a.customer_id',
    [customerId],
  )
  const row = result.rows[0]
  if (!row) return { success: true, account: { customerId, status: 'not-created', balanceSun: '0', entryCount: 0, asset: 'TRX-denominated-internal-credit', network: 'internal-ledger', withdrawableOnChain: false } }
  return {
    success: true,
    account: {
      customerId: row.customer_id, status: row.status, balanceSun: String(row.balance_sun),
      entryCount: Number(row.entry_count), createdAt: row.created_at, updatedAt: row.updated_at,
      asset: 'TRX-denominated-internal-credit', network: 'internal-ledger', withdrawableOnChain: false,
    },
  }
}

export async function allocateRestrictedTrxCredit(input = {}) {
  const validation = validateRestrictedTrxCreditAllocation(input)
  if (!validation.valid) return { success: false, error: validation.error }
  const actorAddress = typeof input.actorAddress === 'string' ? input.actorAddress.trim() : ''
  if (!actorAddress || actorAddress.length > 64) return { success: false, error: 'invalid-actor' }
  const db = getDatabasePool()
  if (!db) return { success: false, error: 'database-not-configured' }
  await initializeDatabase()
  await ensureSchema(db)
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query('INSERT INTO ' + ACCOUNTS + ' (customer_id) VALUES ($1) ON CONFLICT (customer_id) DO NOTHING', [validation.customerId])
    const account = await client.query('SELECT status FROM ' + ACCOUNTS + ' WHERE customer_id=$1 FOR UPDATE', [validation.customerId])
    if (account.rows[0]?.status !== 'active') {
      await client.query('ROLLBACK')
      return { success: false, error: 'credit-account-not-active' }
    }
    const inserted = await client.query(
      'INSERT INTO ' + ENTRIES + ' (id,customer_id,entry_type,amount_sun,delta_sun,idempotency_key,actor_address,reason) ' +
      'VALUES ($1,$2,\'allocation\',$3,$3,$4,$5,$6) ON CONFLICT (customer_id,idempotency_key) DO NOTHING RETURNING id::text AS id,created_at',
      [randomUUID(), validation.customerId, validation.amountSun, validation.idempotencyKey, actorAddress, validation.reason],
    )
    let entry = inserted.rows[0]
    let duplicate = false
    if (!entry) {
      const existing = await client.query('SELECT id::text AS id,amount_sun::text AS amount_sun,created_at FROM ' + ENTRIES + ' WHERE customer_id=$1 AND idempotency_key=$2',
        [validation.customerId, validation.idempotencyKey])
      if (!existing.rows[0] || existing.rows[0].amount_sun !== validation.amountSun) {
        await client.query('ROLLBACK')
        return { success: false, error: 'idempotency-conflict' }
      }
      entry = existing.rows[0]
      duplicate = true
    }
    const balance = await client.query('SELECT COALESCE(SUM(delta_sun),0)::text AS balance_sun FROM ' + ENTRIES + ' WHERE customer_id=$1', [validation.customerId])
    await client.query('COMMIT')
    return {
      success: true, duplicate,
      entry: { id: entry.id, customerId: validation.customerId, amountSun: validation.amountSun, createdAt: entry.created_at },
      account: { customerId: validation.customerId, balanceSun: String(balance.rows[0].balance_sun), asset: 'TRX-denominated-internal-credit', network: 'internal-ledger', withdrawableOnChain: false },
      disclosure: 'Internal restricted credit only. Not actual TRX, not a Bitpie deposit, and not withdrawable on-chain.',
    }
  } catch (error) {
    try { await client.query('ROLLBACK') } catch {}
    throw error
  } finally { client.release() }
}
