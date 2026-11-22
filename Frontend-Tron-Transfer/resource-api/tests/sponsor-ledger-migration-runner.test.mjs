import test from 'node:test'
import assert from 'node:assert/strict'
import { pauseSourceLedgerWrites, resolveMigrationRunnerConfig, runMigrationTask } from '../scripts/run-sponsor-ledger-migration.mjs'\nimport { normalizePostgresTlsMode } from '../scripts/sponsor-ledger-database-identity.mjs'

const source = 'postgresql://source:secret@dpg-source.singapore-postgres.render.com/sponsor?sslmode=require'
const target = 'postgresql://neon:secret@ep-target.c-9.us-east-2.aws.neon.tech/sponsor?sslmode=require'
const safeEnv = {
  DATABASE_URL: source,
  SPONSOR_MIGRATION_TARGET_DATABASE_URL: target,
  SPONSOR_MIGRATION_TARGET_DATABASE_URL_POOLED: 'postgresql://neon:secret@ep-target-pooler.c-9.aws.neon.tech/sponsor',
  SPONSOR_WRITES_PAUSED: 'true',
  SPONSOR_TRANSACTION_ENGINE_ENABLED: 'false',
  SPONSOR_MAINNET_BROADCAST_ENABLED: 'false',
  SPONSOR_MIGRATION_BACKUP_VERIFIED: 'true',
  SPONSOR_MIGRATION_ROLLBACK_PLAN_CONFIRMED: 'true',
}

test('runner selects existing runtime source and direct Neon target without exposing URLs', () => {
  const config = resolveMigrationRunnerConfig(safeEnv)
  assert.equal(config.sourceUrl, source)
  assert.equal(config.targetUrl, target)
})

test('runner follows Sponsor-specific runtime database precedence', () => {
  const config = resolveMigrationRunnerConfig({
    ...safeEnv,
    SPONSOR_DATABASE_URL_POOLED: 'postgresql://source:secret@dpg-source.singapore-postgres.render.com/sponsor?sslmode=require',
    SPONSOR_DATABASE_URL: 'postgresql://ignored:secret@ignored.example/sponsor',
  })
  assert.equal(config.sourceUrl, 'postgresql://source:secret@dpg-source.singapore-postgres.render.com/sponsor?sslmode=require')
})

test('runner refuses unless the durable write pause is explicitly confirmed', () => {
  assert.throws(() => resolveMigrationRunnerConfig({ ...safeEnv, SPONSOR_WRITES_PAUSED: 'false' }), /SPONSOR_WRITES_PAUSED=true/)
})

test('runner refuses unless Sponsor transaction execution is explicitly disabled', () => {
  assert.throws(() => resolveMigrationRunnerConfig({ ...safeEnv, SPONSOR_TRANSACTION_ENGINE_ENABLED: 'true' }), /engine must be explicitly disabled/)
  assert.throws(() => resolveMigrationRunnerConfig({ ...safeEnv, SPONSOR_TRANSACTION_ENGINE_ENABLED: undefined }), /engine must be explicitly disabled/)
})

test('runner refuses unless Mainnet broadcasting is explicitly disabled', () => {
  assert.throws(() => resolveMigrationRunnerConfig({ ...safeEnv, SPONSOR_MAINNET_BROADCAST_ENABLED: 'true' }), /broadcasting must be explicitly disabled/)
})

test('runner refuses pooled Neon targets', () => {
  assert.throws(() => resolveMigrationRunnerConfig({
    ...safeEnv,
    SPONSOR_MIGRATION_TARGET_DATABASE_URL: safeEnv.SPONSOR_MIGRATION_TARGET_DATABASE_URL_POOLED,
  }), /direct PostgreSQL endpoint/)
})

test('runner refuses missing source or target and same database identities', () => {
  assert.throws(() => resolveMigrationRunnerConfig({ ...safeEnv, DATABASE_URL: '' }), /source database is not configured/)
  assert.throws(() => resolveMigrationRunnerConfig({ ...safeEnv, SPONSOR_MIGRATION_TARGET_DATABASE_URL: '' }), /target is not configured/)
  assert.throws(() => resolveMigrationRunnerConfig({
    ...safeEnv,
    DATABASE_URL: target,
  }), /identities are the same/)
})

test('migration requires a verified recoverable backup before starting the copy', async () => {
  let spawned = false
  await assert.rejects(
    runMigrationTask('migrate', {
      env: { ...safeEnv, SPONSOR_MIGRATION_BACKUP_VERIFIED: 'false' },
      spawn: () => { spawned = true; return { status: 0 } },
    }),
    /verify a recoverable source backup/,
  )
  assert.equal(spawned, false)
})

test('migration requires an explicit rollback and source-retention plan', async () => {
  let spawned = false
  await assert.rejects(
    runMigrationTask('migrate', {
      env: { ...safeEnv, SPONSOR_MIGRATION_ROLLBACK_PLAN_CONFIRMED: 'false' },
      spawn: () => { spawned = true; return { status: 0 } },
    }),
    /source-retention and rollback plan/,
  )
  assert.equal(spawned, false)
})

test('runner ignores arbitrary source URL overrides and pins the runtime-selected source', async () => {
  let invocation
  const status = await runMigrationTask('migrate', {
    env: { ...safeEnv, SOURCE_DATABASE_URL: 'postgresql://attacker:secret@other.example/other' },
    spawn: (...args) => { invocation = args; return { status: 0 } },
  })
  assert.equal(status, 0)
  assert.equal(invocation[2].env.SOURCE_DATABASE_URL, source)
  assert.equal(invocation[2].env.TARGET_DATABASE_URL, target)
})

test('pause step durably creates or updates the source write-control gate and verifies it', async () => {
  const queries = []
  class FakePool {
    constructor(options) { assert.equal(options.connectionString, normalizePostgresTlsMode(source)) }
    async query(sql) {
      queries.push(sql)
      if (sql.includes('to_regclass')) return { rows: [{ operations_table: 'tron_transfer_sponsor_operations' }] }
      if (sql.includes('SELECT writes_paused')) return { rows: [{ writes_paused: true }] }
      return { rows: [] }
    }
    async end() {}
  }
  const result = await pauseSourceLedgerWrites(source, { PoolClass: FakePool })
  assert.deepEqual(result, { success: true, writesPaused: true })
  assert.equal(queries.some(sql => sql.includes('CREATE TABLE IF NOT EXISTS public.tron_transfer_sponsor_control')), true)
  assert.equal(queries.some(sql => sql.includes('ON CONFLICT (id) DO UPDATE') && sql.includes('writes_paused = TRUE')), true)
})

test('runner validates task mode before starting any migration process', async () => {
  let spawned = false
  await assert.rejects(
    runMigrationTask('anything', { env: safeEnv, spawn: () => { spawned = true; return { status: 0 } } }),
    /Usage:/,
  )
  assert.equal(spawned, false)
})

test('migration runner pools use explicit strict TLS while retaining database identity', async () => {
  const seen = []
  class FakePool {
    constructor(options) { seen.push(options.connectionString) }
    async query(sql) {
      if (sql.includes('to_regclass')) return { rows: [{ operations_table: 'tron_transfer_sponsor_operations' }] }
      if (sql.includes('SELECT writes_paused')) return { rows: [{ writes_paused: true }] }
      return { rows: [] }
    }
    async end() {}
  }
  await pauseSourceLedgerWrites(source, { PoolClass: FakePool })
  assert.deepEqual(seen, [normalizePostgresTlsMode(source)])
  assert.equal(new URL(seen[0]).searchParams.get('sslmode'), 'verify-full')
})
