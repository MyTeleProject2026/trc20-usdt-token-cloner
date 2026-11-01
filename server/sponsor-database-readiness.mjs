const SPONSOR_SCHEMA = 'trc20_token_clone'

export const SPONSOR_DATABASE_REQUIRED_COLUMNS = Object.freeze({
  sponsor_budgets: [
    'sponsor_reference', 'network', 'purpose', 'asset', 'token_contract',
    'budget_base_units', 'reserved_base_units', 'spent_base_units', 'status',
    'sponsor_address', 'approval_reference', 'review_reference', 'approved_at',
  ],
  sponsor_transfers: [
    'idempotency_key', 'sponsor_reference', 'network', 'purpose', 'asset',
    'token_contract', 'receiver_address', 'amount_base_units', 'status',
    'transaction_hash', 'authorization_reference', 'sponsor_address',
    'prepared_transaction', 'prepared_raw_data_hex', 'prepared_txid',
  ],
  sponsor_chain_cost_observations: [
    'network', 'transaction_hash', 'idempotency_key', 'sponsor_reference',
    'fee_sponsor_address', 'asset_principal_address', 'receiver_address', 'asset',
    'token_contract', 'amount_base_units', 'block_number', 'block_timestamp_ms',
    'execution_result', 'reported_fee_sun', 'energy_fee_sun', 'net_fee_sun',
    'energy_usage_total', 'energy_usage', 'origin_energy_usage', 'net_usage',
    'energy_penalty_total',
  ],
  sponsor_resource_budgets: [
    'mandate_reference', 'sponsor_reference', 'network', 'fee_sponsor_address',
    'asset_principal_address', 'energy_budget_units', 'bandwidth_budget_units',
    'energy_per_transfer_limit', 'bandwidth_per_transfer_limit',
    'energy_reserved_units', 'bandwidth_reserved_units', 'energy_spent_units',
    'bandwidth_spent_units', 'valid_until', 'status', 'approval_reference',
    'review_reference', 'approved_at',
  ],
  sponsor_resource_reservations: [
    'idempotency_key', 'budget_id', 'network', 'transaction_hash',
    'energy_reserved_units', 'bandwidth_reserved_units', 'status', 'expires_at',
    'preflight_evidence', 'preflight_checked_at',
  ],
  sponsor_resource_cost_settlements: [
    'network', 'transaction_hash', 'idempotency_key', 'budget_id', 'block_number',
    'block_timestamp_ms', 'energy_used_units', 'bandwidth_used_units',
    'reported_fee_sun', 'energy_fee_sun', 'net_fee_sun', 'evidence_source',
    'status', 'evidence', 'observed_at',
  ],
  sponsor_resource_delegations: [
    'network', 'transaction_hash', 'sponsor_address', 'receiver_address',
    'resource_type', 'stake_equivalent_sun', 'block_number', 'verification_status',
  ],
  audit_events: [
    'event_type', 'entity_type', 'entity_reference', 'details', 'created_at',
  ],
})

export const SPONSOR_DATABASE_REQUIRED_INDEXES = Object.freeze([
  { tableName: 'sponsor_budgets', indexName: 'idx_ttc_sponsor_budget_identity' },
  { tableName: 'sponsor_transfers', indexName: 'idx_ttc_sponsor_transfer_tx_identity' },
  { tableName: 'sponsor_transfers', indexName: 'idx_ttc_sponsor_transfers_status_created' },
  { tableName: 'sponsor_chain_cost_observations', indexName: 'idx_ttc_sponsor_chain_cost_observations_created' },
  { tableName: 'sponsor_resource_budgets', indexName: 'idx_ttc_sponsor_resource_budgets_pair' },
  { tableName: 'sponsor_resource_budgets', indexName: 'idx_ttc_sponsor_resource_budgets_one_active_pair' },
  { tableName: 'sponsor_resource_reservations', indexName: 'idx_ttc_sponsor_resource_reservations_budget' },
  { tableName: 'sponsor_resource_delegations', indexName: 'idx_ttc_resource_delegations_pair_block' },
])

export const SPONSOR_DATABASE_REQUIRED_CONSTRAINTS = Object.freeze([
  { tableName: 'sponsor_budgets', constraintName: 'sponsor_budgets_network_fee_requires_trx' },
  { tableName: 'sponsor_budgets', constraintName: 'sponsor_budgets_asset_contract_shape' },
  { tableName: 'sponsor_budgets', constraintName: 'sponsor_budgets_supported_asset_only' },
  { tableName: 'sponsor_transfers', constraintName: 'sponsor_transfers_network_fee_requires_trx' },
  { tableName: 'sponsor_transfers', constraintName: 'sponsor_transfers_asset_contract_shape' },
  { tableName: 'sponsor_transfers', constraintName: 'sponsor_transfers_supported_asset_only' },
  { tableName: 'sponsor_chain_cost_observations', constraintName: 'sponsor_chain_cost_observations_supported_asset_only' },
])

const READINESS_QUERY = `
WITH required_tables AS (
  SELECT table_name
  FROM jsonb_to_recordset($1::jsonb) AS expected(table_name text)
),
table_status AS (
  SELECT required.table_name,
         EXISTS (
           SELECT 1
             FROM information_schema.tables actual
            WHERE actual.table_schema = $5
              AND actual.table_name = required.table_name
              AND actual.table_type = 'BASE TABLE'
         ) AS present
    FROM required_tables required
),
required_columns AS (
  SELECT table_name, column_name
    FROM jsonb_to_recordset($2::jsonb) AS expected(table_name text, column_name text)
),
column_status AS (
  SELECT required.table_name, required.column_name,
         EXISTS (
           SELECT 1
             FROM information_schema.columns actual
            WHERE actual.table_schema = $5
              AND actual.table_name = required.table_name
              AND actual.column_name = required.column_name
         ) AS present
    FROM required_columns required
),
required_indexes AS (
  SELECT table_name, index_name
    FROM jsonb_to_recordset($3::jsonb) AS expected(table_name text, index_name text)
),
index_status AS (
  SELECT required.table_name, required.index_name,
         EXISTS (
           SELECT 1
             FROM pg_indexes actual
            WHERE actual.schemaname = $5
              AND actual.tablename = required.table_name
              AND actual.indexname = required.index_name
         ) AS present
    FROM required_indexes required
),
required_constraints AS (
  SELECT table_name, constraint_name
    FROM jsonb_to_recordset($4::jsonb) AS expected(table_name text, constraint_name text)
),
constraint_status AS (
  SELECT required.table_name, required.constraint_name,
         EXISTS (
           SELECT 1
             FROM pg_constraint actual
             JOIN pg_class relation ON relation.oid = actual.conrelid
             JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = $5
              AND relation.relname = required.table_name
              AND actual.conname = required.constraint_name
         ) AS present
    FROM required_constraints required
)
SELECT current_database() AS database_name,
       EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $5) AS schema_present,
       COALESCE((SELECT jsonb_agg(jsonb_build_object(
         'tableName', table_name, 'present', present
       ) ORDER BY table_name) FROM table_status), '[]'::jsonb) AS tables,
       COALESCE((SELECT jsonb_agg(jsonb_build_object(
         'tableName', table_name, 'columnName', column_name, 'present', present
       ) ORDER BY table_name, column_name) FROM column_status), '[]'::jsonb) AS columns,
       COALESCE((SELECT jsonb_agg(jsonb_build_object(
         'tableName', table_name, 'indexName', index_name, 'present', present
       ) ORDER BY table_name, index_name) FROM index_status), '[]'::jsonb) AS indexes,
       COALESCE((SELECT jsonb_agg(jsonb_build_object(
         'tableName', table_name, 'constraintName', constraint_name, 'present', present
       ) ORDER BY table_name, constraint_name) FROM constraint_status), '[]'::jsonb) AS constraints
`

function missingEntries(entries, format) {
  if (!Array.isArray(entries)) return ['readiness-query-returned-invalid-metadata']
  return entries.filter((entry) => entry?.present !== true).map(format)
}

/**
 * Inspect sponsor-ledger schema metadata using SELECT-only PostgreSQL catalog
 * and information_schema reads. This function never creates or changes schema.
 */
export async function inspectSponsorDatabaseReadiness(queryable) {
  if (!queryable || typeof queryable.query !== 'function') {
    throw new TypeError('A PostgreSQL query-compatible client is required')
  }

  const requiredTables = Object.keys(SPONSOR_DATABASE_REQUIRED_COLUMNS).map((tableName) => ({ tableName }))
  const requiredColumns = Object.entries(SPONSOR_DATABASE_REQUIRED_COLUMNS)
    .flatMap(([tableName, columns]) => columns.map((columnName) => ({ tableName, columnName })))

  const result = await queryable.query(READINESS_QUERY, [
    JSON.stringify(requiredTables.map(({ tableName }) => ({ table_name: tableName }))),
    JSON.stringify(requiredColumns.map(({ tableName, columnName }) => ({ table_name: tableName, column_name: columnName }))),
    JSON.stringify(SPONSOR_DATABASE_REQUIRED_INDEXES.map(({ tableName, indexName }) => ({ table_name: tableName, index_name: indexName }))),
    JSON.stringify(SPONSOR_DATABASE_REQUIRED_CONSTRAINTS.map(({ tableName, constraintName }) => ({ table_name: tableName, constraint_name: constraintName }))),
    SPONSOR_SCHEMA,
  ])
  const row = result?.rows?.[0]
  if (!row) throw new Error('Sponsor database readiness query returned no result')

  const missingTables = missingEntries(row.tables, (entry) => entry.tableName)
  const missingColumns = missingEntries(row.columns, (entry) => entry.tableName + '.' + entry.columnName)
  const missingIndexes = missingEntries(row.indexes, (entry) => entry.tableName + '.' + entry.indexName)
  const missingConstraints = missingEntries(row.constraints, (entry) => entry.tableName + '.' + entry.constraintName)
  const schemaPresent = row.schema_present === true
  const ready = schemaPresent
    && missingTables.length === 0
    && missingColumns.length === 0
    && missingIndexes.length === 0
    && missingConstraints.length === 0

  return {
    status: ready ? 'ready' : 'needs-migration-or-repair',
    ready,
    readOnly: true,
    releaseAuthorized: false,
    submissionEnabled: false,
    databaseName: typeof row.database_name === 'string' ? row.database_name : null,
    schema: SPONSOR_SCHEMA,
    schemaPresent,
    requiredTableCount: requiredTables.length,
    requiredColumnCount: requiredColumns.length,
    requiredIndexCount: SPONSOR_DATABASE_REQUIRED_INDEXES.length,
    requiredConstraintCount: SPONSOR_DATABASE_REQUIRED_CONSTRAINTS.length,
    missingTables,
    missingColumns,
    missingIndexes,
    missingConstraints,
  }
}
