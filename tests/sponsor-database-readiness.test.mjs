import test from 'node:test'
import assert from 'node:assert/strict'
import { SPONSOR_RESOURCE_LEDGER_SCHEMA_VERSION } from '../server/sponsor-database-version.mjs'
import {
  inspectSponsorDatabaseReadiness,
  SPONSOR_DATABASE_REQUIRED_COLUMNS,
  SPONSOR_DATABASE_REQUIRED_INDEXES,
  SPONSOR_DATABASE_REQUIRED_CONSTRAINTS,
} from '../server/sponsor-database-readiness.mjs'

function metadataFixture({
  schemaPresent = true,
  missingTable = null,
  missingColumn = null,
  missingIndex = null,
  missingConstraint = null,
} = {}) {
  const requiredTables = Object.keys(SPONSOR_DATABASE_REQUIRED_COLUMNS)
  const requiredColumns = Object.entries(SPONSOR_DATABASE_REQUIRED_COLUMNS)
    .flatMap(([tableName, columns]) => columns.map((columnName) => ({ tableName, columnName })))
  return {
    database_name: 'sponsor_test',
    schema_present: schemaPresent,
    tables: requiredTables.map((tableName) => ({
      tableName, present: tableName !== missingTable,
    })),
    columns: requiredColumns.map(({ tableName, columnName }) => ({
      tableName, columnName,
      present: !(tableName === missingColumn?.tableName && columnName === missingColumn?.columnName),
    })),
    indexes: SPONSOR_DATABASE_REQUIRED_INDEXES.map(({ tableName, indexName }) => ({
      tableName, indexName,
      present: !(tableName === missingIndex?.tableName && indexName === missingIndex?.indexName),
    })),
    constraints: SPONSOR_DATABASE_REQUIRED_CONSTRAINTS.map(({ tableName, constraintName }) => ({
      tableName, constraintName,
      present: !(tableName === missingConstraint?.tableName && constraintName === missingConstraint?.constraintName),
    })),
  }
}

function queryableWith(metadata, { migrationApplied = true } = {}) {
  const calls = []
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql, values })
      if (sql.startsWith('SELECT version FROM trc20_token_clone.schema_migrations')) {
        return { rows: migrationApplied ? [{ version: SPONSOR_RESOURCE_LEDGER_SCHEMA_VERSION }] : [] }
      }
      return { rows: [metadata] }
    },
  }
}

test('sponsor database readiness passes when every required object exists and stays read-only', async () => {
  const client = queryableWith(metadataFixture())
  const report = await inspectSponsorDatabaseReadiness(client)

  assert.equal(report.status, 'ready')
  assert.equal(report.ready, true)
  assert.equal(report.readOnly, true)
  assert.equal(report.migrationRecorded, true)
  assert.equal(report.requiredMigrationVersion, SPONSOR_RESOURCE_LEDGER_SCHEMA_VERSION)
  assert.deepEqual(report.missingMigrations, [])
  assert.equal(report.releaseAuthorized, false)
  assert.equal(report.submissionEnabled, false)
  assert.equal(report.databaseName, 'sponsor_test')
  assert.equal(report.missingTables.length, 0)
  assert.equal(report.missingColumns.length, 0)
  assert.equal(report.missingIndexes.length, 0)
  assert.equal(report.missingConstraints.length, 0)
  assert.equal(client.calls.length, 2)
  assert.match(client.calls[1].sql, /^SELECT version FROM trc20_token_studio\.schema_migrations/)
  assert.deepEqual(client.calls[1].values, [SPONSOR_RESOURCE_LEDGER_SCHEMA_VERSION])
  assert.doesNotMatch(client.calls[1].sql, /\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE)\b/i)
  const [tables, columns, indexes, constraints, schema] = client.calls[0].values
  assert.equal(schema, 'trc20_token_clone')
  assert.ok(JSON.parse(tables).every((entry) => typeof entry.table_name === 'string'))
  assert.ok(JSON.parse(columns).every((entry) => typeof entry.table_name === 'string' && typeof entry.column_name === 'string'))
  assert.ok(JSON.parse(indexes).every((entry) => typeof entry.table_name === 'string' && typeof entry.index_name === 'string'))
  assert.ok(JSON.parse(constraints).every((entry) => typeof entry.table_name === 'string' && typeof entry.constraint_name === 'string'))
  assert.match(client.calls[0].sql, /^\s*WITH/)
  assert.doesNotMatch(client.calls[0].sql, /\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE)\b/i)
})

test('sponsor database readiness reports missing resource-ledger columns and indexes', async () => {
  const client = queryableWith(metadataFixture({
    missingColumn: { tableName: 'sponsor_resource_reservations', columnName: 'preflight_evidence' },
    missingIndex: { tableName: 'sponsor_resource_budgets', indexName: 'idx_ttc_sponsor_resource_budgets_one_active_pair' },
  }))
  const report = await inspectSponsorDatabaseReadiness(client)

  assert.equal(report.ready, false)
  assert.equal(report.status, 'needs-migration-or-repair')
  assert.ok(report.missingColumns.includes('sponsor_resource_reservations.preflight_evidence'))
  assert.ok(report.missingIndexes.includes('sponsor_resource_budgets.idx_ttc_sponsor_resource_budgets_one_active_pair'))
})

test('sponsor database readiness reports missing tables, constraints and schema', async () => {
  const client = queryableWith(metadataFixture({
    schemaPresent: false,
    missingTable: 'sponsor_resource_cost_settlements',
    missingConstraint: {
      tableName: 'sponsor_transfers',
      constraintName: 'sponsor_transfers_network_fee_requires_trx',
    },
  }))
  const report = await inspectSponsorDatabaseReadiness(client)

  assert.equal(report.ready, false)
  assert.equal(report.schemaPresent, false)
  assert.equal(client.calls.length, 1)
  assert.ok(report.missingTables.includes('sponsor_resource_cost_settlements'))
  assert.ok(report.missingConstraints.includes('sponsor_transfers.sponsor_transfers_network_fee_requires_trx'))
})

test('sponsor database readiness blocks when the required sponsor schema marker is absent', async () => {
  const client = queryableWith(metadataFixture(), { migrationApplied: false })
  const report = await inspectSponsorDatabaseReadiness(client)

  assert.equal(report.ready, false)
  assert.equal(report.migrationRecorded, false)
  assert.deepEqual(report.missingMigrations, [SPONSOR_RESOURCE_LEDGER_SCHEMA_VERSION])
})

test('sponsor database readiness rejects invalid clients and empty query results', async () => {
  await assert.rejects(inspectSponsorDatabaseReadiness(null), /query-compatible client/)
  await assert.rejects(inspectSponsorDatabaseReadiness({ query: async () => ({ rows: [] }) }), /returned no result/)
})
