import test from 'node:test'
import assert from 'node:assert/strict'
import { assessMigrationPreflight, assessSponsorLedgerSchema } from '../scripts/check-sponsor-ledger-migration.mjs'
import { databaseIdentity } from '../scripts/sponsor-ledger-database-identity.mjs'

const ready = {
  operatorConfirmed: true,
  sourceTargetDistinct: true,
  sourceOperationsTable: true,
  sourceControlTable: true,
  sourceWritesPaused: true,
  sourceInFlightCount: '0',
  sourceColumnsComplete: true,
  targetOperationsTable: false,
  targetRowCount: null,
  targetColumnsComplete: false,
  targetControlTable: false,
  targetWritesPaused: null,
}

test('database identity ignores query options but distinguishes databases and roles', () => {
  assert.equal(
    databaseIdentity('postgresql://user:secret@db.example.test:5432/ledger?sslmode=require'),
    databaseIdentity('postgresql://user:secret@db.example.test/ledger?sslmode=verify-full'),
  )
  assert.notEqual(
    databaseIdentity('postgresql://user:secret@db.example.test/ledger'),
    databaseIdentity('postgresql://user:secret@db.example.test/other'),
  )
  assert.equal(
    databaseIdentity('postgresql://user:secret@db.example.test/ledger'),
    databaseIdentity('postgresql://other:secret@db.example.test/ledger'),
  )
})

test('a distinct source with a paused, complete and idle ledger can migrate to an empty target', () => {
  assert.deepEqual(assessMigrationPreflight(ready), { readyToMigrate: true, blockers: [] })
})

test('operator pause confirmation is mandatory', () => {
  const result = assessMigrationPreflight({ ...ready, operatorConfirmed: false })
  assert.equal(result.readyToMigrate, false)
  assert.ok(result.blockers.includes('operator-pause-confirmation-required'))
})

test('source control row must confirm Sponsor writes are paused', () => {
  for (const value of [false, null]) {
    const result = assessMigrationPreflight({ ...ready, sourceWritesPaused: value })
    assert.ok(result.blockers.includes('source-writes-not-confirmed-paused'))
  }
})

test('missing source schema or required columns blocks migration', () => {
  const result = assessMigrationPreflight({
    ...ready,
    sourceOperationsTable: false,
    sourceColumnsComplete: false,
  })
  assert.ok(result.blockers.includes('source-ledger-table-missing'))
  assert.ok(result.blockers.includes('source-ledger-schema-incomplete'))
})

test('source and existing target require persisted prepared and signed transaction payload columns', () => {
  const result = assessMigrationPreflight({
    ...ready,
    sourceColumnsComplete: false,
    targetOperationsTable: true,
    targetRowCount: '0',
    targetColumnsComplete: false,
  })
  assert.ok(result.blockers.includes('source-ledger-schema-incomplete'))
  assert.ok(result.blockers.includes('target-ledger-schema-incomplete'))
})

test('any in-flight or ambiguous operation blocks migration', () => {
  for (const count of ['1', '2', '-1']) {
    const result = assessMigrationPreflight({ ...ready, sourceInFlightCount: count })
    assert.ok(result.blockers.includes('source-ledger-has-in-flight-or-unreadable-operations'))
  }
})

test('a populated target ledger blocks migration rather than overwriting existing history', () => {
  const result = assessMigrationPreflight({
    ...ready,
    targetOperationsTable: true,
    targetRowCount: '3',
    targetColumnsComplete: true,
  })
  assert.ok(result.blockers.includes('target-ledger-must-be-empty'))
})

test('an existing target control row must be present and paused', () => {
  const result = assessMigrationPreflight({
    ...ready,
    targetControlTable: true,
    targetWritesPaused: false,
  })
  assert.ok(result.blockers.includes('existing-target-write-control-not-paused'))
})

test('an existing empty target ledger must have the complete schema', () => {
  const result = assessMigrationPreflight({
    ...ready,
    targetOperationsTable: true,
    targetRowCount: '0',
    targetColumnsComplete: false,
  })
  assert.ok(result.blockers.includes('target-ledger-schema-incomplete'))
})

test('source and target must be distinct even when URLs differ only in query parameters', () => {
  const sameDatabase = databaseIdentity('postgresql://user:secret@db.example.test/ledger?sslmode=require')
    === databaseIdentity('postgresql://user:secret@db.example.test/ledger?sslmode=disable')
  const result = assessMigrationPreflight({ ...ready, sourceTargetDistinct: !sameDatabase })
  assert.ok(result.blockers.includes('source-and-target-must-be-distinct'))
})

test('legacy Sponsor schema is accepted only for an empty source and never for non-empty or target ledgers', () => {
  const core = [
    'id', 'idempotency_key_hash', 'request_hash', 'operation', 'resource',
    'amount_sun', 'sponsor_address', 'owner_address', 'status', 'transaction_id',
    'result_code', 'confirmation_block', 'created_at', 'updated_at',
  ]
  const legacyEmpty = assessSponsorLedgerSchema(core, { role: 'source', rowCount: '0' })
  assert.equal(legacyEmpty.compatible, true)
  assert.equal(legacyEmpty.legacyEmptySource, true)
  assert.equal(assessSponsorLedgerSchema(core, { role: 'source', rowCount: '4' }).compatible, false)
  assert.equal(assessSponsorLedgerSchema(core, { role: 'target', rowCount: '0' }).compatible, false)
  assert.equal(assessSponsorLedgerSchema(['id'], { role: 'source', rowCount: '0' }).compatible, false)
})
