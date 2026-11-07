import { ensureSponsorDirectPayoutSchema } from './sponsor-direct-payout-schema.mjs'

const DEFAULT_SCHEMA = 'trc20_token_clone'
const MINIMUM_WITHDRAWAL_BASE_UNITS = '1000000000'
const ARCHIVE_LOCK_SUFFIX = ':sponsor_direct_payouts:archive:v1'
const TERMINAL_STATUSES = "'broadcast-rejected','confirmed','failed','cancelled','expired'"
const PAYOUT_COLUMNS = [
  'id', 'idempotency_key', 'requester_address', 'sponsor_address',
  'recipient_address', 'token_contract', 'amount_base_units', 'status',
  'unsigned_transaction', 'signed_transaction', 'transaction_hash',
  'failure_code', 'expires_at', 'created_at', 'updated_at',
  'confirmation_block_number', 'confirmation_log_index',
  'confirmation_verified_at', 'confirmation_evidence',
  'reconciliation_last_checked_at', 'reconciliation_attempts',
  'reconciliation_last_error',
]
const COLUMN_LIST = PAYOUT_COLUMNS.join(', ')
const migrationsByDatabase = new WeakMap()

function validatedSchemaName(value) {
  if (typeof value !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(value)) {
    throw new TypeError('A valid PostgreSQL schema identifier is required.')
  }
  return value
}

/**
 * Archives only terminal below-minimum records. Any lower-value row that may
 * still need processing or settlement reconciliation blocks the entire
 * migration. Active payouts are left in the live table and receive a validated
 * unconditional minimum constraint.
 */
export async function ensureSponsorDirectPayoutArchiveSchema(db, { schemaName = DEFAULT_SCHEMA } = {}) {
  const schema = validatedSchemaName(schemaName)
  if (!db || (typeof db !== 'object' && typeof db !== 'function')) {
    throw new TypeError('A PostgreSQL database pool or client is required.')
  }

  await ensureSponsorDirectPayoutSchema(db, { schemaName: schema })

  let migrations = migrationsByDatabase.get(db)
  if (!migrations) {
    migrations = new Map()
    migrationsByDatabase.set(db, migrations)
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
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [schema + ARCHIVE_LOCK_SUFFIX])
      await client.query('LOCK TABLE ' + schema + '.sponsor_direct_payouts IN ACCESS EXCLUSIVE MODE')

      const unresolved = await client.query(
        'SELECT COUNT(*)::text AS count FROM ' + schema + '.sponsor_direct_payouts ' +
        'WHERE amount_base_units < $1::numeric AND status NOT IN (' + TERMINAL_STATUSES + ')',
        [MINIMUM_WITHDRAWAL_BASE_UNITS],
      )
      if (String(unresolved.rows?.[0]?.count ?? '0') !== '0') {
        throw new Error('Sponsor payout archive migration blocked: unresolved below-minimum payout records require explicit resolution.')
      }

      await client.query(
        'CREATE TABLE IF NOT EXISTS ' + schema + '.sponsor_direct_payouts_archive ' +
        '(LIKE ' + schema + '.sponsor_direct_payouts INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING IDENTITY)'
      )
      await client.query(
        'ALTER TABLE ' + schema + '.sponsor_direct_payouts_archive ' +
        'DROP COLUMN IF EXISTS minimum_policy_blocked, ' +
        'ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NOT NULL DEFAULT now(), ' +
        'ADD COLUMN IF NOT EXISTS archive_reason TEXT NOT NULL DEFAULT \'below-minimum-terminal-record\', ' +
        'ADD COLUMN IF NOT EXISTS archive_schema_version INTEGER NOT NULL DEFAULT 1'
      )
      await client.query(
        `DO $archive_constraints$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = '${schema}.sponsor_direct_payouts_archive'::regclass
              AND conname = 'sponsor_direct_payouts_archive_pkey'
          ) THEN
            ALTER TABLE ${schema}.sponsor_direct_payouts_archive
              ADD CONSTRAINT sponsor_direct_payouts_archive_pkey PRIMARY KEY (id);
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = '${schema}.sponsor_direct_payouts_archive'::regclass
              AND conname = 'sponsor_direct_payouts_archive_idempotency_key_key'
          ) THEN
            ALTER TABLE ${schema}.sponsor_direct_payouts_archive
              ADD CONSTRAINT sponsor_direct_payouts_archive_idempotency_key_key UNIQUE (idempotency_key);
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = '${schema}.sponsor_direct_payouts_archive'::regclass
              AND conname = 'sponsor_direct_payouts_archive_amount_positive_check'
          ) THEN
            ALTER TABLE ${schema}.sponsor_direct_payouts_archive
              ADD CONSTRAINT sponsor_direct_payouts_archive_amount_positive_check CHECK (amount_base_units > 0);
          END IF;
        END; $archive_constraints$`
      )
      await client.query(
        'CREATE INDEX IF NOT EXISTS sponsor_direct_payouts_archive_requester_idx ON ' +
        schema + '.sponsor_direct_payouts_archive (requester_address, created_at DESC)'
      )
      await client.query(
        'CREATE INDEX IF NOT EXISTS sponsor_direct_payouts_archive_sponsor_idx ON ' +
        schema + '.sponsor_direct_payouts_archive (sponsor_address, created_at DESC)'
      )

      await client.query(
        'INSERT INTO ' + schema + '.sponsor_direct_payouts_archive (' + COLUMN_LIST +
        ', archived_at, archive_reason, archive_schema_version) ' +
        'SELECT ' + COLUMN_LIST + ', now(), \'below-minimum-terminal-record\', 1 ' +
        'FROM ' + schema + '.sponsor_direct_payouts ' +
        'WHERE amount_base_units < $1::numeric AND status IN (' + TERMINAL_STATUSES + ') ' +
        'ON CONFLICT (id) DO NOTHING',
        [MINIMUM_WITHDRAWAL_BASE_UNITS],
      )

      const mismatches = await client.query(
        'SELECT COUNT(*)::text AS count FROM ' + schema + '.sponsor_direct_payouts source ' +
        'LEFT JOIN ' + schema + '.sponsor_direct_payouts_archive archived ON archived.id=source.id ' +
        'WHERE source.amount_base_units < $1::numeric AND source.status IN (' + TERMINAL_STATUSES + ') ' +
        'AND (archived.id IS NULL OR ROW(' + PAYOUT_COLUMNS.map((column) => 'archived.' + column).join(', ') +
        ') IS DISTINCT FROM ROW(' + PAYOUT_COLUMNS.map((column) => 'source.' + column).join(', ') + '))',
        [MINIMUM_WITHDRAWAL_BASE_UNITS],
      )
      if (String(mismatches.rows?.[0]?.count ?? '0') !== '0') {
        throw new Error('Sponsor payout archive migration blocked: historical row copy did not verify exactly.')
      }

      await client.query(
        'DELETE FROM ' + schema + '.sponsor_direct_payouts ' +
        'WHERE amount_base_units < $1::numeric AND status IN (' + TERMINAL_STATUSES + ')',
        [MINIMUM_WITHDRAWAL_BASE_UNITS],
      )

      const invalidArchiveRows = await client.query(
        'SELECT COUNT(*)::text AS count FROM ' + schema + '.sponsor_direct_payouts_archive ' +
        'WHERE amount_base_units >= $1::numeric OR status NOT IN (' + TERMINAL_STATUSES + ')',
        [MINIMUM_WITHDRAWAL_BASE_UNITS],
      )
      if (String(invalidArchiveRows.rows?.[0]?.count ?? '0') !== '0') {
        throw new Error('Sponsor payout archive migration blocked: archive contains a non-historical or non-terminal record.')
      }
      const overlappingRows = await client.query(
        'SELECT COUNT(*)::text AS count FROM ' + schema + '.sponsor_direct_payouts active ' +
        'JOIN ' + schema + '.sponsor_direct_payouts_archive archived ' +
        'ON active.id=archived.id OR active.idempotency_key=archived.idempotency_key'
      )
      if (String(overlappingRows.rows?.[0]?.count ?? '0') !== '0') {
        throw new Error('Sponsor payout archive migration blocked: active and archive records overlap.')
      }

      await client.query(
        'CREATE TABLE IF NOT EXISTS ' + schema + '.sponsor_direct_payout_idempotency_registry (' +
        'idempotency_key UUID PRIMARY KEY, payout_id UUID NOT NULL UNIQUE, ' +
        'requester_address TEXT NOT NULL, recipient_address TEXT NOT NULL, ' +
        'amount_base_units NUMERIC(78,0) NOT NULL CHECK (amount_base_units > 0), ' +
        'created_at TIMESTAMPTZ NOT NULL DEFAULT now())'
      )
      await client.query(
        'INSERT INTO ' + schema + '.sponsor_direct_payout_idempotency_registry ' +
        '(idempotency_key,payout_id,requester_address,recipient_address,amount_base_units,created_at) ' +
        'SELECT idempotency_key,id,requester_address,recipient_address,amount_base_units,created_at FROM ' +
        schema + '.sponsor_direct_payouts UNION ALL ' +
        'SELECT idempotency_key,id,requester_address,recipient_address,amount_base_units,created_at FROM ' +
        schema + '.sponsor_direct_payouts_archive ' +
        'ON CONFLICT (idempotency_key) DO NOTHING'
      )
      const registryMismatches = await client.query(
        'SELECT COUNT(*)::text AS count FROM (' +
        'SELECT idempotency_key,id,requester_address,recipient_address,amount_base_units FROM ' + schema + '.sponsor_direct_payouts ' +
        'UNION ALL SELECT idempotency_key,id,requester_address,recipient_address,amount_base_units FROM ' + schema + '.sponsor_direct_payouts_archive' +
        ') payout LEFT JOIN ' + schema + '.sponsor_direct_payout_idempotency_registry registry ' +
        'ON registry.idempotency_key=payout.idempotency_key ' +
        'WHERE registry.idempotency_key IS NULL OR registry.payout_id IS DISTINCT FROM payout.id ' +
        'OR registry.requester_address IS DISTINCT FROM payout.requester_address ' +
        'OR registry.recipient_address IS DISTINCT FROM payout.recipient_address ' +
        'OR registry.amount_base_units IS DISTINCT FROM payout.amount_base_units'
      )
      if (String(registryMismatches.rows?.[0]?.count ?? '0') !== '0') {
        throw new Error('Sponsor payout archive migration blocked: global idempotency registry does not match payout history.')
      }
      const orphanedRegistry = await client.query(
        'SELECT COUNT(*)::text AS count FROM ' + schema + '.sponsor_direct_payout_idempotency_registry registry ' +
        'WHERE NOT EXISTS (SELECT 1 FROM ' + schema + '.sponsor_direct_payouts active WHERE active.id=registry.payout_id) ' +
        'AND NOT EXISTS (SELECT 1 FROM ' + schema + '.sponsor_direct_payouts_archive archived WHERE archived.id=registry.payout_id)'
      )
      if (String(orphanedRegistry.rows?.[0]?.count ?? '0') !== '0') {
        throw new Error('Sponsor payout archive migration blocked: orphaned idempotency registry entries require investigation.')
      }

      await client.query(
        `CREATE OR REPLACE FUNCTION ${schema}.register_sponsor_direct_payout_idempotency()
         RETURNS trigger LANGUAGE plpgsql AS $register_payout$
         DECLARE existing RECORD;
         BEGIN
           INSERT INTO ${schema}.sponsor_direct_payout_idempotency_registry
             (idempotency_key,payout_id,requester_address,recipient_address,amount_base_units,created_at)
           VALUES (NEW.idempotency_key,NEW.id,NEW.requester_address,NEW.recipient_address,NEW.amount_base_units,NEW.created_at)
           ON CONFLICT DO NOTHING;
           IF NOT FOUND THEN
             IF TG_OP = 'INSERT' THEN
               RAISE EXCEPTION 'Payout idempotency key is already reserved by an existing request.'
                 USING ERRCODE='23505', CONSTRAINT='sponsor_direct_payout_idempotency_registry_key';
             END IF;
             SELECT payout_id,requester_address,recipient_address,amount_base_units
               INTO existing
               FROM ${schema}.sponsor_direct_payout_idempotency_registry
              WHERE idempotency_key=NEW.idempotency_key;
             IF NOT FOUND THEN
               RAISE EXCEPTION 'Payout idempotency key is already reserved by another historical request.'
                 USING ERRCODE='23505', CONSTRAINT='sponsor_direct_payout_idempotency_registry_key';
             END IF;
             IF existing.payout_id IS DISTINCT FROM NEW.id
               OR existing.requester_address IS DISTINCT FROM NEW.requester_address
               OR existing.recipient_address IS DISTINCT FROM NEW.recipient_address
               OR existing.amount_base_units IS DISTINCT FROM NEW.amount_base_units THEN
               RAISE EXCEPTION 'Payout idempotency key is already reserved by another historical request.'
                 USING ERRCODE='23505', CONSTRAINT='sponsor_direct_payout_idempotency_registry_key';
             END IF;
           END IF;
           RETURN NEW;
         END; $register_payout$`
      )
      await client.query(
        'DROP TRIGGER IF EXISTS sponsor_direct_payouts_idempotency_registry_trg ON ' + schema + '.sponsor_direct_payouts'
      )
      await client.query(
        'CREATE TRIGGER sponsor_direct_payouts_idempotency_registry_trg ' +
        'BEFORE INSERT OR UPDATE OF id,idempotency_key,requester_address,recipient_address,amount_base_units ' +
        'ON ' + schema + '.sponsor_direct_payouts FOR EACH ROW ' +
        'EXECUTE FUNCTION ' + schema + '.register_sponsor_direct_payout_idempotency()'
      )
      await client.query(
        `CREATE OR REPLACE FUNCTION ${schema}.reject_sponsor_direct_payout_archive_mutation()
         RETURNS trigger LANGUAGE plpgsql AS $archive_immutable$
         BEGIN
           RAISE EXCEPTION 'Historical sponsor payout archive is immutable.'
             USING ERRCODE='55000';
         END; $archive_immutable$`
      )
      await client.query(
        'DROP TRIGGER IF EXISTS sponsor_direct_payouts_archive_immutable_trg ON ' + schema + '.sponsor_direct_payouts_archive'
      )
      await client.query(
        'CREATE TRIGGER sponsor_direct_payouts_archive_immutable_trg ' +
        'BEFORE UPDATE OR DELETE ON ' + schema + '.sponsor_direct_payouts_archive ' +
        'FOR EACH ROW EXECUTE FUNCTION ' + schema + '.reject_sponsor_direct_payout_archive_mutation()'
      )
      await client.query(
        'DROP TRIGGER IF EXISTS sponsor_direct_payouts_archive_no_truncate_trg ON ' + schema + '.sponsor_direct_payouts_archive'
      )
      await client.query(
        'CREATE TRIGGER sponsor_direct_payouts_archive_no_truncate_trg ' +
        'BEFORE TRUNCATE ON ' + schema + '.sponsor_direct_payouts_archive ' +
        'FOR EACH STATEMENT EXECUTE FUNCTION ' + schema + '.reject_sponsor_direct_payout_archive_mutation()'
      )

      await client.query(
        `DO $active_minimum$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = '${schema}.sponsor_direct_payouts'::regclass
              AND conname = 'sponsor_direct_payouts_minimum_amount_check'
              AND convalidated = TRUE
              AND pg_get_constraintdef(oid) LIKE '%amount_base_units >= ${MINIMUM_WITHDRAWAL_BASE_UNITS}%'
              AND pg_get_constraintdef(oid) NOT LIKE '%minimum_policy_blocked%'
          ) THEN
            ALTER TABLE ${schema}.sponsor_direct_payouts
              DROP CONSTRAINT IF EXISTS sponsor_direct_payouts_minimum_amount_check;
            ALTER TABLE ${schema}.sponsor_direct_payouts
              DROP COLUMN IF EXISTS minimum_policy_blocked;
            ALTER TABLE ${schema}.sponsor_direct_payouts
              ADD CONSTRAINT sponsor_direct_payouts_minimum_amount_check
              CHECK (amount_base_units >= ${MINIMUM_WITHDRAWAL_BASE_UNITS}::numeric) NOT VALID;
            ALTER TABLE ${schema}.sponsor_direct_payouts
              VALIDATE CONSTRAINT sponsor_direct_payouts_minimum_amount_check;
          ELSE
            ALTER TABLE ${schema}.sponsor_direct_payouts
              DROP COLUMN IF EXISTS minimum_policy_blocked;
          END IF;
        END; $active_minimum$`
      )

      const historyColumns = PAYOUT_COLUMNS.map((column) => 'active.' + column).join(', ')
      const archiveColumns = PAYOUT_COLUMNS.map((column) => 'archived.' + column).join(', ')
      await client.query(
        'CREATE OR REPLACE VIEW ' + schema + '.sponsor_direct_payouts_history AS ' +
        'SELECT ' + historyColumns + ', FALSE AS is_archived, NULL::timestamptz AS archived_at, NULL::text AS archive_reason ' +
        'FROM ' + schema + '.sponsor_direct_payouts active UNION ALL ' +
        'SELECT ' + archiveColumns + ', TRUE AS is_archived, archived.archived_at, archived.archive_reason ' +
        'FROM ' + schema + '.sponsor_direct_payouts_archive archived'
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

const DIAGNOSTICS_MINIMUM_BASE_UNITS = '1000000000'

function validateDiagnosticsSchema(value) {
  if (typeof value !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(value)) {
    throw new TypeError('A valid PostgreSQL schema identifier is required.')
  }
  return value
}

/**
 * Read-only, owner-facing snapshot of archive migration invariants.
 * This function never initializes, repairs, or mutates schema objects.
 */
export async function readSponsorDirectPayoutArchiveDiagnostics(db, { schemaName = 'trc20_token_clone' } = {}) {
  const schema = validateDiagnosticsSchema(schemaName)
  if (!db || typeof db.query !== 'function') throw new TypeError('A PostgreSQL query client is required.')

  const relations = await db.query(
    'SELECT to_regclass($1) AS active_table, to_regclass($2) AS archive_table, ' +
    'to_regclass($3) AS history_view, to_regclass($4) AS registry_table',
    [
      schema + '.sponsor_direct_payouts',
      schema + '.sponsor_direct_payouts_archive',
      schema + '.sponsor_direct_payouts_history',
      schema + '.sponsor_direct_payout_idempotency_registry',
    ],
  )
  const found = relations.rows?.[0] || {}
  if (!found.active_table) {
    return {
      status: 'not-initialized',
      schema,
      checks: { activeTable: false, archiveTable: false, historyView: false, idempotencyRegistry: false },
      counts: { active: 0, archived: 0, unresolvedBelowMinimum: 0, registry: 0, registryMismatches: 0 },
    }
  }
  if (!found.archive_table || !found.history_view || !found.registry_table) {
    return {
      status: 'incomplete',
      schema,
      checks: {
        activeTable: true,
        archiveTable: Boolean(found.archive_table),
        historyView: Boolean(found.history_view),
        idempotencyRegistry: Boolean(found.registry_table),
      },
      counts: { active: null, archived: null, unresolvedBelowMinimum: null, registry: null, registryMismatches: null },
    }
  }

  const [counts, constraints, triggers, registry] = await Promise.all([
    db.query(
      'SELECT (SELECT COUNT(*)::int FROM ' + schema + '.sponsor_direct_payouts) AS active, ' +
      '(SELECT COUNT(*)::int FROM ' + schema + '.sponsor_direct_payouts_archive) AS archived, ' +
      '(SELECT COUNT(*)::int FROM ' + schema + '.sponsor_direct_payouts ' +
      'WHERE amount_base_units < $1::numeric AND status NOT IN (' + TERMINAL_STATUSES + ')) AS unresolved_below_minimum, ' +
      '(SELECT COUNT(*)::int FROM ' + schema + '.sponsor_direct_payout_idempotency_registry) AS registry',
      [DIAGNOSTICS_MINIMUM_BASE_UNITS],
    ),
    db.query(
      'SELECT convalidated, pg_get_constraintdef(oid) AS definition FROM pg_constraint ' +
      'WHERE conrelid=$1::regclass AND conname=$2',
      [schema + '.sponsor_direct_payouts', 'sponsor_direct_payouts_minimum_amount_check'],
    ),
    db.query(
      'SELECT c.relname, t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid ' +
      'JOIN pg_namespace n ON n.oid=c.relnamespace ' +
      'WHERE n.nspname=$1 AND NOT t.tgisinternal AND t.tgname IN ' +
      "('sponsor_direct_payouts_idempotency_registry_trg','sponsor_direct_payouts_archive_immutable_trg','sponsor_direct_payouts_archive_no_truncate_trg')",
      [schema],
    ),
    db.query(
      'SELECT COUNT(*)::int AS mismatches FROM (' +
      'SELECT idempotency_key,id,requester_address,recipient_address,amount_base_units FROM ' + schema + '.sponsor_direct_payouts ' +
      'UNION ALL SELECT idempotency_key,id,requester_address,recipient_address,amount_base_units FROM ' + schema + '.sponsor_direct_payouts_archive' +
      ') payout LEFT JOIN ' + schema + '.sponsor_direct_payout_idempotency_registry registry ' +
      'ON registry.idempotency_key=payout.idempotency_key ' +
      'WHERE registry.idempotency_key IS NULL OR registry.payout_id IS DISTINCT FROM payout.id ' +
      'OR registry.requester_address IS DISTINCT FROM payout.requester_address ' +
      'OR registry.recipient_address IS DISTINCT FROM payout.recipient_address ' +
      'OR registry.amount_base_units IS DISTINCT FROM payout.amount_base_units',
    ),
  ])

  const countRow = counts.rows?.[0] || {}
  const constraint = constraints.rows?.[0]
  const triggerNames = new Set((triggers.rows || []).map((row) => row.tgname))
  const checks = {
    activeTable: true,
    archiveTable: true,
    historyView: true,
    idempotencyRegistry: true,
    activeMinimumValidated: constraint?.convalidated === true &&
      String(constraint.definition || '').includes('amount_base_units >=') &&
      !String(constraint.definition || '').includes('minimum_policy_blocked'),
    activeIdempotencyTrigger: triggerNames.has('sponsor_direct_payouts_idempotency_registry_trg'),
    archiveUpdateDeleteProtection: triggerNames.has('sponsor_direct_payouts_archive_immutable_trg'),
    archiveTruncateProtection: triggerNames.has('sponsor_direct_payouts_archive_no_truncate_trg'),
    registryConsistent: Number(registry.rows?.[0]?.mismatches || 0) === 0,
  }
  const unresolved = Number(countRow.unresolved_below_minimum || 0)
  const status = unresolved > 0 ? 'blocked' :
    Object.values(checks).every(Boolean) ? 'ready' : 'incomplete'

  return {
    status,
    schema,
    minimumWithdrawalBaseUnits: DIAGNOSTICS_MINIMUM_BASE_UNITS,
    checks,
    counts: {
      active: Number(countRow.active || 0),
      archived: Number(countRow.archived || 0),
      unresolvedBelowMinimum: unresolved,
      registry: Number(countRow.registry || 0),
      registryMismatches: Number(registry.rows?.[0]?.mismatches || 0),
    },
  }
}
