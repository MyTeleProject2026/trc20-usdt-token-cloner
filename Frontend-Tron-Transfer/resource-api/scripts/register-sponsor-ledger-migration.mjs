import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'
import { normalizePostgresTlsMode } from './sponsor-ledger-database-identity.mjs'

const { Pool } = pg
const VERSION = '20261126_sponsor_operations_ledger.sql'
export function ownerAdminDatabaseIdentityFingerprint(value) {
  const parsed = new URL(value)
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname || parsed.pathname === '/') {
    throw new Error('invalid-postgres-database-url')
  }
  // Keep this byte-for-byte compatible with scripts/print-database-identity-fingerprint.mjs.
  const identity = JSON.stringify({
    hostname: parsed.hostname.toLowerCase(),
    port: parsed.port || '5432',
    database: decodeURIComponent(parsed.pathname.slice(1)),
    username: decodeURIComponent(parsed.username),
  })
  return createHash('sha256').update(identity).digest('hex')
}

const REQUIRED_COLUMNS = [
  'id', 'idempotency_key_hash', 'request_hash', 'operation', 'resource', 'amount_sun',
  'sponsor_address', 'owner_address', 'status', 'transaction_id', 'prepared_transaction',
  'signed_transaction', 'result_code', 'confirmation_block', 'created_at', 'updated_at',
]
const REQUIRED_CONSTRAINTS = [
  'tron_transfer_sponsor_operations_amount_sun_check',
  'tron_transfer_sponsor_operations_idempotency_key_hash_key',
  'tron_transfer_sponsor_operations_operation_check',
  'tron_transfer_sponsor_operations_pkey',
  'tron_transfer_sponsor_operations_resource_check',
  'tron_transfer_sponsor_operations_status_check',
]
const REQUIRED_INDEXES = [
  'tron_transfer_sponsor_operations_pkey',
  'tron_transfer_sponsor_operations_idempotency_key_hash_key',
  'tron_transfer_sponsor_operations_sponsor_created',
]

export async function registerSponsorLedgerMigration({ env = process.env, PoolClass = Pool } = {}) {
  const connectionString = env.OWNER_ADMIN_DATABASE_URL || env.DATABASE_URL
  const expectedIdentity = String(env.OWNER_ADMIN_EXPECTED_DATABASE_IDENTITY_SHA256 || '').trim().toLowerCase()
  if (!connectionString || !/^[0-9a-f]{64}$/.test(expectedIdentity)) {
    throw new Error('Owner Admin database URL and expected database identity fingerprint are required.')
  }
  const actualIdentity = ownerAdminDatabaseIdentityFingerprint(connectionString)
  if (actualIdentity !== expectedIdentity) throw new Error('Sponsor ledger migration refused: production database identity did not match the pinned fingerprint.')

  const scriptDirectory = dirname(fileURLToPath(import.meta.url))
  const migrationPath = resolve(scriptDirectory, '../migrations/' + VERSION)
  const checksum = createHash('sha256').update(await readFile(migrationPath)).digest('hex')
  const pool = new Pool({
    connectionString: normalizePostgresTlsMode(connectionString),
    max: 1,
    connectionTimeoutMillis: 8000,
    query_timeout: 8000,
    statement_timeout: 8000,
  })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const table = await client.query("SELECT to_regclass('public.tron_transfer_sponsor_operations') AS operations, to_regclass('public.tron_transfer_sponsor_control') AS control")
    if (!table.rows?.[0]?.operations || !table.rows?.[0]?.control) throw new Error('Sponsor ledger tables are missing; run the separately authorized schema bootstrap first.')

    const columns = await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='tron_transfer_sponsor_operations'")
    const foundColumns = new Set((columns.rows || []).map(row => row.column_name))
    const missingColumns = REQUIRED_COLUMNS.filter(column => !foundColumns.has(column))
    if (missingColumns.length) throw new Error('Sponsor ledger schema is incomplete: ' + missingColumns.join(', '))

    const constraints = await client.query("SELECT conname FROM pg_constraint WHERE conrelid='public.tron_transfer_sponsor_operations'::regclass")
    const foundConstraints = new Set((constraints.rows || []).map(row => row.conname))
    const missingConstraints = REQUIRED_CONSTRAINTS.filter(name => !foundConstraints.has(name))
    if (missingConstraints.length) throw new Error('Sponsor ledger constraints are incomplete: ' + missingConstraints.join(', '))

    const indexes = await client.query("SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='tron_transfer_sponsor_operations'")
    const foundIndexes = new Set((indexes.rows || []).map(row => row.indexname))
    const missingIndexes = REQUIRED_INDEXES.filter(name => !foundIndexes.has(name))
    if (missingIndexes.length) throw new Error('Sponsor ledger indexes are incomplete: ' + missingIndexes.join(', '))

    const control = await client.query('SELECT writes_paused FROM public.tron_transfer_sponsor_control WHERE id=1')
    if (control.rows?.length !== 1 || control.rows[0].writes_paused !== true) {
      throw new Error('Sponsor ledger migration registration requires the existing durable write pause to remain enabled.')
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.tron_transfer_owner_admin_schema_migrations (
        version TEXT PRIMARY KEY,
        checksum CHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
    const prior = await client.query('SELECT checksum FROM public.tron_transfer_owner_admin_schema_migrations WHERE version=$1 FOR UPDATE', [VERSION])
    if (prior.rows?.length && String(prior.rows[0].checksum).trim() !== checksum) {
      throw new Error('Sponsor ledger migration checksum conflict; refusing to overwrite the recorded checksum.')
    }
    if (!prior.rows?.length) {
      await client.query('INSERT INTO public.tron_transfer_owner_admin_schema_migrations (version, checksum) VALUES ($1, $2)', [VERSION, checksum])
    }
    await client.query('COMMIT')
    return { success: true, version: VERSION, checksum, registered: !prior.rows?.length, sponsorWritesPaused: true }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await registerSponsorLedgerMigration()
    process.stdout.write(JSON.stringify(result) + '\\n')
  } catch (error) {
    process.stderr.write('Sponsor ledger migration registration blocked: ' + String(error?.message || 'unknown error') + '\\n')
    process.exitCode = 1
  }
}
