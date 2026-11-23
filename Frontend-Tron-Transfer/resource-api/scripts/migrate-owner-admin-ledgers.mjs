import pg from 'pg'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { normalizePostgresTlsMode } from './sponsor-ledger-database-identity.mjs'

const { Pool } = pg
const root = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(root, '..', 'migrations')
const ACK = 'APPLY_TRON_TRANSFER_OWNER_ADMIN_MIGRATIONS'

export async function applyOwnerAdminMigrations(client, migrations) {
  const applied = [], skipped = []
  await client.query('BEGIN')
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('tron-transfer-owner-admin-migrations'))")
    await client.query("CREATE TABLE IF NOT EXISTS public.tron_transfer_owner_admin_schema_migrations (version TEXT PRIMARY KEY, checksum CHAR(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'), applied_at TIMESTAMPTZ NOT NULL DEFAULT now())")
    for (const migration of migrations) {
      const checksum = createHash('sha256').update(migration.sql).digest('hex')
      const prior = await client.query('SELECT checksum FROM public.tron_transfer_owner_admin_schema_migrations WHERE version=$1', [migration.version])
      if (prior.rows?.[0]) {
        if (prior.rows[0].checksum !== checksum) throw new Error('Applied migration checksum changed: ' + migration.version)
        skipped.push(migration.version)
        continue
      }
      await client.query(migration.sql)
      await client.query('INSERT INTO public.tron_transfer_owner_admin_schema_migrations (version,checksum) VALUES ($1,$2)', [migration.version, checksum])
      applied.push(migration.version)
    }
    await client.query('COMMIT')
    return { applied, skipped }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }
}

async function main() {
  if (process.env.OWNER_ADMIN_MIGRATIONS_ACK !== ACK) throw new Error('Set OWNER_ADMIN_MIGRATIONS_ACK=' + ACK + ' only after a verified Neon backup and restore plan.')
  const connection = process.env.OWNER_ADMIN_DATABASE_URL || process.env.SPONSOR_DATABASE_URL || process.env.DATABASE_URL
  if (!connection) throw new Error('Set OWNER_ADMIN_DATABASE_URL, SPONSOR_DATABASE_URL, or DATABASE_URL to the direct PostgreSQL URL. Values are never printed.')
  let host = ''
  try { host = new URL(connection).hostname } catch { throw new Error('The direct PostgreSQL URL is invalid.') }
  if (host.includes('-pooler.')) throw new Error('Owner Admin migrations require a direct PostgreSQL endpoint, not a transaction pooler.')
  const names = (await readdir(migrationsDir)).filter(name => /^\d{8}_[a-z0-9_-]+\.sql$/.test(name)).sort()
  if (!names.length) throw new Error('No Owner Admin migrations were found.')
  const migrations = await Promise.all(names.map(async name => ({ version: name, sql: await readFile(join(migrationsDir, name), 'utf8') })))
  const pool = new Pool({ connectionString: normalizePostgresTlsMode(connection), max: 1, connectionTimeoutMillis: 8000, query_timeout: 65000, statement_timeout: 60000, idleTimeoutMillis: 1000 })
  let client
  try {
    client = await pool.connect()
    const result = await applyOwnerAdminMigrations(client, migrations)
    const check = await client.query("SELECT to_regclass('public.tron_transfer_wallet_accounts') IS NOT NULL AS wallet_accounts, to_regclass('public.tron_transfer_wallet_sessions') IS NOT NULL AS wallet_sessions, to_regclass('public.tron_transfer_owner_operations') IS NOT NULL AS owner_operations, to_regclass('public.tron_transfer_deployments') IS NOT NULL AS trax_deployments, to_regclass('public.tron_transfer_wallet_recovery_tokens') IS NOT NULL AS recovery_tokens, to_regclass('public.tron_transfer_pending_owner_sessions') IS NOT NULL AS pending_owner_sessions, to_regclass('public.tron_transfer_pending_owner_acceptances') IS NOT NULL AS pending_owner_acceptances")
    const checks = check.rows?.[0] || {}
    const missing = Object.entries(checks).filter(([, value]) => value !== true).map(([name]) => name)
    if (missing.length) throw new Error('Migration postflight is missing required tables: ' + missing.join(', '))
    process.stdout.write(JSON.stringify({ success: true, applied: result.applied, alreadyApplied: result.skipped, postflight: checks, note: 'No credentials, connection details, row contents or wallet keys were printed.' }) + '\n')
  } finally {
    client?.release()
    await pool.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write('Owner Admin database migration failed: ' + String(error?.message || 'unknown error') + '\n')
    process.exitCode = 1
  })
}
