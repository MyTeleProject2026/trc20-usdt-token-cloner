import { spawnSync } from 'node:child_process'
import pg from 'pg'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sponsorDatabaseConnectionString } from '../sponsor-api.mjs'
import { databaseIdentity } from './sponsor-ledger-database-identity.mjs'

const { Pool } = pg

export function resolveMigrationRunnerConfig(env = process.env) {
  if (env.SPONSOR_WRITES_PAUSED !== 'true') {
    throw new Error('Set SPONSOR_WRITES_PAUSED=true only after Sponsor writes and Mainnet broadcasts are disabled.')
  }
  if (env.SPONSOR_TRANSACTION_ENGINE_ENABLED !== 'false') {
    throw new Error('Sponsor transaction engine must be explicitly disabled.')
  }
  if (env.SPONSOR_MAINNET_BROADCAST_ENABLED !== 'false') {
    throw new Error('Sponsor Mainnet broadcasting must be explicitly disabled.')
  }

  // Use the database selected by the running API's normal precedence. Do not
  // accept an arbitrary SOURCE_DATABASE_URL override in this operational tool.
  const sourceUrl = sponsorDatabaseConnectionString(env)
  const targetUrl = typeof env.SPONSOR_MIGRATION_TARGET_DATABASE_URL === 'string'
    ? env.SPONSOR_MIGRATION_TARGET_DATABASE_URL.trim()
    : ''

  if (!sourceUrl) throw new Error('The existing Resource API source database is not configured.')
  if (!targetUrl) throw new Error('The Neon direct migration target is not configured.')

  let target
  try {
    target = new URL(targetUrl)
  } catch {
    throw new Error('The migration target URL is invalid.')
  }
  if (!['postgres:', 'postgresql:'].includes(target.protocol)
    || !target.hostname.endsWith('.neon.tech')
    || target.hostname.includes('-pooler')) {
    throw new Error('The migration target must be the Neon direct PostgreSQL endpoint, not a pooled endpoint.')
  }
  if (databaseIdentity(sourceUrl) === databaseIdentity(targetUrl)) {
    throw new Error('Source and target database identities are the same; refusing migration.')
  }

  return { sourceUrl, targetUrl }
}

export async function pauseSourceLedgerWrites(sourceUrl, { PoolClass = Pool } = {}) {
  const db = new PoolClass({ connectionString: sourceUrl, max: 1, connectionTimeoutMillis: 8000 })
  try {
    const ledger = await db.query(
      "SELECT to_regclass('public.tron_transfer_sponsor_operations') AS operations_table"
    )
    if (!ledger.rows?.[0]?.operations_table) {
      throw new Error('The source Sponsor operations table does not exist; refusing to create a partial ledger.')
    }
    await db.query(`
      CREATE TABLE IF NOT EXISTS public.tron_transfer_sponsor_control (
        id SMALLINT PRIMARY KEY CHECK (id = 1),
        writes_paused BOOLEAN NOT NULL DEFAULT TRUE,
        pause_reason TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
    await db.query(`
      INSERT INTO public.tron_transfer_sponsor_control (id, writes_paused, pause_reason)
      VALUES (1, TRUE, 'sponsor-ledger-migration-preflight')
      ON CONFLICT (id) DO UPDATE SET
        writes_paused = TRUE,
        pause_reason = 'sponsor-ledger-migration-preflight',
        updated_at = now()
    `)
    const control = await db.query(
      'SELECT writes_paused FROM public.tron_transfer_sponsor_control WHERE id=1'
    )
    if (control.rows?.length !== 1 || control.rows[0].writes_paused !== true) {
      throw new Error('The source Sponsor write pause could not be verified.')
    }
    return { success: true, writesPaused: true }
  } finally {
    await db.end()
  }
}

export async function runMigrationTask(mode, { env = process.env, spawn = spawnSync, PoolClass = Pool } = {}) {
  if (!['pause', 'preflight', 'migrate'].includes(mode)) {
    throw new Error('Usage: npm run sponsor-ledger:pause, sponsor-ledger:preflight, or sponsor-ledger:migrate')
  }
  const { sourceUrl, targetUrl } = resolveMigrationRunnerConfig(env)
  const taskEnv = {
    ...env,
    SOURCE_DATABASE_URL: sourceUrl,
    TARGET_DATABASE_URL: targetUrl,
    SPONSOR_WRITES_PAUSED: 'true',
  }

  if (mode === 'pause') {
    const result = await pauseSourceLedgerWrites(sourceUrl, { PoolClass })
    process.stdout.write(JSON.stringify({
      ...result,
      note: 'Source Sponsor writes are durably paused. Run the read-only preflight next; Mainnet broadcasting remains disabled.',
    }) + '\\n')
    return 0
  }

  if (mode === 'preflight') {
    const { runSponsorLedgerPreflight } = await import('./check-sponsor-ledger-migration.mjs')
    const result = await runSponsorLedgerPreflight({ env: taskEnv })
    process.stdout.write(JSON.stringify(result) + '\n')
    return result.readyToMigrate ? 0 : 1
  }

  const script = resolve('scripts/migrate-sponsor-ledger.mjs')
  const result = spawn(process.execPath, [script], { env: taskEnv, stdio: 'inherit' })
  if (result.error) throw new Error('Could not start the Sponsor ledger migration process.')
  if (result.signal) throw new Error('Sponsor ledger migration process terminated by signal ' + result.signal + '.')
  return Number.isInteger(result.status) ? result.status : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const code = await runMigrationTask(process.argv[2])
    if (code !== 0) process.exitCode = code
  } catch (error) {
    process.stderr.write('Sponsor ledger task blocked: ' + String(error?.message || 'unknown error') + '\n')
    process.exitCode = 1
  }
}
