const SCHEMA = 'trc20_token_clone'
const MINIMUM_WITHDRAWAL_BASE_UNITS = '1000000000'
const MIGRATION_LOCK_KEY = 'trc20_token_clone:sponsor_direct_payouts:schema:v1'

const inFlightByDatabase = new WeakMap()

/**
 * The single schema owner for sponsor_direct_payouts.
 * A transaction-scoped advisory lock serializes this migration across processes.
 * An exclusive table lock prevents concurrent writers slipping rows between the
 * historical backfill and installation of the minimum-policy constraint.
 */
export async function ensureSponsorDirectPayoutSchema(db) {
  if (!db || (typeof db !== 'object' && typeof db !== 'function')) {
    throw new TypeError('A PostgreSQL database pool or client is required.')
  }
  const existing = inFlightByDatabase.get(db)
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
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [MIGRATION_LOCK_KEY])
      await client.query('CREATE SCHEMA IF NOT EXISTS ' + SCHEMA)
      await client.query(
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
      await client.query(
        'ALTER TABLE ' + SCHEMA + '.sponsor_direct_payouts ' +
        'ADD COLUMN IF NOT EXISTS confirmation_block_number BIGINT, ' +
        'ADD COLUMN IF NOT EXISTS confirmation_log_index INTEGER, ' +
        'ADD COLUMN IF NOT EXISTS confirmation_verified_at TIMESTAMPTZ, ' +
        'ADD COLUMN IF NOT EXISTS confirmation_evidence JSONB, ' +
        'ADD COLUMN IF NOT EXISTS reconciliation_last_checked_at TIMESTAMPTZ, ' +
        'ADD COLUMN IF NOT EXISTS reconciliation_attempts INTEGER NOT NULL DEFAULT 0, ' +
        'ADD COLUMN IF NOT EXISTS reconciliation_last_error TEXT, ' +
        'ADD COLUMN IF NOT EXISTS minimum_policy_blocked BOOLEAN NOT NULL DEFAULT FALSE'
      )
      await client.query('LOCK TABLE ' + SCHEMA + '.sponsor_direct_payouts IN ACCESS EXCLUSIVE MODE')
      await client.query(
        'CREATE INDEX IF NOT EXISTS sponsor_direct_payouts_requester_idx ON ' +
        SCHEMA + '.sponsor_direct_payouts (requester_address, created_at DESC)'
      )
      await client.query(
        'CREATE INDEX IF NOT EXISTS sponsor_direct_payouts_sponsor_status_idx ON ' +
        SCHEMA + '.sponsor_direct_payouts (sponsor_address, status, created_at DESC)'
      )
      await client.query(
        'UPDATE ' + SCHEMA + '.sponsor_direct_payouts SET minimum_policy_blocked=TRUE ' +
        'WHERE amount_base_units < ' + MINIMUM_WITHDRAWAL_BASE_UNITS + '::numeric AND minimum_policy_blocked=FALSE'
      )
      await client.query(
        `DO $sponsor_payout_minimum$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'sponsor_direct_payouts_minimum_amount_check'
              AND conrelid = '${SCHEMA}.sponsor_direct_payouts'::regclass
          ) THEN
            ALTER TABLE ${SCHEMA}.sponsor_direct_payouts
              ADD CONSTRAINT sponsor_direct_payouts_minimum_amount_check
              CHECK (amount_base_units >= ${MINIMUM_WITHDRAWAL_BASE_UNITS}::numeric OR minimum_policy_blocked=TRUE) NOT VALID;
          END IF;
        END; $sponsor_payout_minimum$`
      )
      await client.query(
        'CREATE INDEX IF NOT EXISTS sponsor_direct_payouts_reconciliation_idx ON ' +
        SCHEMA + '.sponsor_direct_payouts (updated_at ASC) ' +
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

  inFlightByDatabase.set(db, migration)
  try {
    await migration
  } catch (error) {
    inFlightByDatabase.delete(db)
    throw error
  }
}
