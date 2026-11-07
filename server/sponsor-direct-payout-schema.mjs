const DEFAULT_SCHEMA = 'trc20_token_clone'
const MIGRATION_LOCK_SUFFIX = ':sponsor_direct_payouts:schema:v1'

const inFlightByDatabase = new WeakMap()

function validatedSchemaName(value) {
  if (typeof value !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(value)) {
    throw new TypeError('A valid PostgreSQL schema identifier is required.')
  }
  return value
}

/**
 * Canonical base-table initializer for sponsor_direct_payouts.
 * Historical minimum-policy conversion is owned by
 * ensureSponsorDirectPayoutArchiveSchema, which runs after this initializer.
 */
export async function ensureSponsorDirectPayoutSchema(db, { schemaName = DEFAULT_SCHEMA } = {}) {
  const schema = validatedSchemaName(schemaName)
  if (!db || (typeof db !== 'object' && typeof db !== 'function')) {
    throw new TypeError('A PostgreSQL database pool or client is required.')
  }

  let migrations = inFlightByDatabase.get(db)
  if (!migrations) {
    migrations = new Map()
    inFlightByDatabase.set(db, migrations)
  }
  const existing = migrations.get(schema)
  if (existing) return existing

  const migration = (async () => {
    const client = typeof db.connect === 'function' ? await db.connect() : db
    const release = client !== db && typeof client.release === 'function'
      ? () => client.release()
      : null
    let transactionStarted = false
    try {
      await client.query('BEGIN')
      transactionStarted = true
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [schema + MIGRATION_LOCK_SUFFIX])
      await client.query('CREATE SCHEMA IF NOT EXISTS ' + schema)
      await client.query(
        'CREATE TABLE IF NOT EXISTS ' + schema + '.sponsor_direct_payouts (' +
        'id UUID PRIMARY KEY, idempotency_key UUID NOT NULL UNIQUE, requester_address TEXT NOT NULL, ' +
        'sponsor_address TEXT, recipient_address TEXT NOT NULL, token_contract TEXT NOT NULL, ' +
        'amount_base_units NUMERIC(78,0) NOT NULL CHECK (amount_base_units > 0), ' +
        'status TEXT NOT NULL DEFAULT \'requested\' CHECK (status IN ' +
        '(\'requested\',\'prepared\',\'broadcasting\',\'submitted\',\'outcome-unknown\',\'broadcast-rejected\',\'confirmed\',\'failed\',\'manual-review\',\'cancelled\',\'expired\')), ' +
        'unsigned_transaction JSONB, signed_transaction JSONB, transaction_hash CHAR(64), ' +
        'failure_code TEXT, expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), ' +
        'updated_at TIMESTAMPTZ NOT NULL DEFAULT now())'
      )
      await client.query(
        'ALTER TABLE ' + schema + '.sponsor_direct_payouts ' +
        'ADD COLUMN IF NOT EXISTS confirmation_block_number BIGINT, ' +
        'ADD COLUMN IF NOT EXISTS confirmation_log_index INTEGER, ' +
        'ADD COLUMN IF NOT EXISTS confirmation_verified_at TIMESTAMPTZ, ' +
        'ADD COLUMN IF NOT EXISTS confirmation_evidence JSONB, ' +
        'ADD COLUMN IF NOT EXISTS reconciliation_last_checked_at TIMESTAMPTZ, ' +
        'ADD COLUMN IF NOT EXISTS reconciliation_attempts INTEGER NOT NULL DEFAULT 0, ' +
        'ADD COLUMN IF NOT EXISTS reconciliation_last_error TEXT'
      )
      await client.query('LOCK TABLE ' + schema + '.sponsor_direct_payouts IN ACCESS EXCLUSIVE MODE')
      await client.query(
        'CREATE INDEX IF NOT EXISTS sponsor_direct_payouts_requester_idx ON ' +
        schema + '.sponsor_direct_payouts (requester_address, created_at DESC)'
      )
      await client.query(
        'CREATE INDEX IF NOT EXISTS sponsor_direct_payouts_sponsor_status_idx ON ' +
        schema + '.sponsor_direct_payouts (sponsor_address, status, created_at DESC)'
      )
      await client.query(
        'CREATE INDEX IF NOT EXISTS sponsor_direct_payouts_reconciliation_idx ON ' +
        schema + '.sponsor_direct_payouts (updated_at ASC) ' +
        "WHERE status IN ('broadcasting','submitted','outcome-unknown')"
      )
      await client.query('COMMIT')
      transactionStarted = false
    } catch (error) {
      if (transactionStarted) {
        try { await client.query('ROLLBACK') } catch { /* preserve original error */ }
      }
      throw error
    } finally {
      release?.()
    }
  })()

  migrations.set(schema, migration)
  try {
    await migration
  } catch (error) {
    migrations.delete(schema)
    throw error
  }
}
