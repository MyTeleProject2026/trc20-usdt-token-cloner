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

export function ownerAdminDatabaseIdentityFingerprint(connection) {
  let parsed
  try { parsed = new URL(String(connection || '')) } catch { throw new Error('invalid-owner-admin-database-url') }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname || parsed.pathname === '/') {
    throw new Error('invalid-owner-admin-database-url')
  }
  const identity = JSON.stringify({
    hostname: parsed.hostname.toLowerCase(),
    port: parsed.port || '5432',
    database: decodeURIComponent(parsed.pathname.slice(1)),
    username: decodeURIComponent(parsed.username),
  })
  return createHash('sha256').update(identity).digest('hex')
}

export function assertOwnerAdminDatabaseIdentity(connection, expectedFingerprint) {
  const expected = String(expectedFingerprint || '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('missing-owner-admin-database-identity-pin')
  const actual = ownerAdminDatabaseIdentityFingerprint(connection)
  if (actual !== expected) throw new Error('owner-admin-database-identity-mismatch')
  return actual
}

// Migration files may be run independently, but this orchestrator owns the one
// transaction spanning the complete ordered migration set. Strip only an
// optional outer BEGIN/COMMIT envelope so a file cannot commit that transaction.
export function stripOuterTransactionEnvelope(sql) {
  let source = String(sql)
  source = source.replace(/^\s*(?:(?:--[^\r\n]*(?:\r?\n|$))|(?:\/\*[\s\S]*?\*\/\s*))*BEGIN(?:\s+TRANSACTION)?\s*;\s*/i, '')
  source = source.replace(/\s*COMMIT(?:\s+TRANSACTION)?\s*;\s*$/i, '')
  return source.trim()
}

// Both known ledgers have been independently observed on Neon. Reconciliation
// is permitted only when the live schema fingerprint below matches exactly.
export const LEGACY_MIGRATION_CHECKSUMS = Object.freeze({
  '20261122_backend_wallet_auth.sql': ['13d46d37a8d9104c504697f3fa9538c0295b5dcdd2e3bd89357823facee5fcc8', '2c64cbb8f18ccbe46d57eff40142e7c1efaf8fa4c12f6021c00d22f0e970113e'],
  '20261123_owner_operation_ledger.sql': ['5f056a1ed512b1e464192188a672bad592d48c25f11155603fd3cf2aeda721db', '5c48c0966058e44327f23d710d5ea52b86645785e251062e50be05742d591162'],
  '20261123_trax_deployment_ledger.sql': ['f062f3b7657b871a0d267c14c3eecc2b7e32e144cf83368f3db5b07868496649', 'a1b1a68f35e94a1bd5aa3b94872d33f487a8e18ceda812a689b7f79bd4b3974b'],
  '20261124_owner_recovery_tokens.sql': ['fad19fb2964ad12144e3578e16a72a37281788d41fc7a58c110e6464f73ad85f', '80585e097c725ad87fbc6bc25704783c6467f7f270e5a4acad234dbaf548641a'],
  '20261125_pending_owner_acceptance.sql': ['c7c0457e4d60568f69623e1bcc30e3eafb14951bb8a264a03c14f0ef04ecedd7', '0ce8052ca264467b0bbc5f88ab56e262d35886f6e673e2224142166e05c9759d'],
  '20261126_wallet_recovery_roles.sql': ['28c197c62eaf7f7757dad409cbaa6df0b82380bab64840d97a9817085a8187fe', '854d2cb8342c4289a85d88092626f8f31ce19bc027076eea8cab3f29977ed229'],
})

export const OWNER_ADMIN_SCHEMA_FINGERPRINT = 'f950a9bf0464f74fff0a039453bb2fe40f1873561ae2b0499b7837dd66bd5364'

const OWNER_ADMIN_SCHEMA_FINGERPRINT_SQL = String.raw`WITH target(table_name) AS (VALUES
 ('tron_transfer_wallet_accounts'),('tron_transfer_wallet_sessions'),('tron_transfer_wallet_auth_audit'),
 ('tron_transfer_owner_operations'),('tron_transfer_deployments'),('tron_transfer_wallet_recovery_tokens'),
 ('tron_transfer_pending_owner_challenges'),('tron_transfer_pending_owner_sessions'),
 ('tron_transfer_pending_owner_acceptances'),('tron_transfer_sponsor_control')
), cols AS (
 SELECT string_agg(concat_ws('|',c.table_name,c.column_name,c.ordinal_position,c.data_type,c.is_nullable,COALESCE(c.column_default,''),c.is_identity,c.identity_generation,c.is_generated,COALESCE(c.generation_expression,'')),E'\\n' ORDER BY c.table_name,c.ordinal_position) v
 FROM information_schema.columns c JOIN target t USING(table_name) WHERE c.table_schema='public'
), cons AS (
 SELECT string_agg(concat_ws('|',r.relname,k.conname,k.contype,pg_get_constraintdef(k.oid)),E'\\n' ORDER BY r.relname,k.conname) v
 FROM pg_constraint k JOIN pg_class r ON r.oid=k.conrelid JOIN target t ON t.table_name=r.relname WHERE k.connamespace='public'::regnamespace
), idx AS (
 SELECT string_agg(concat_ws('|',i.tablename,i.indexname,i.indexdef),E'\\n' ORDER BY i.tablename,i.indexname) v
 FROM pg_indexes i JOIN target t ON t.table_name=i.tablename WHERE i.schemaname='public'
), seqs AS (
 SELECT string_agg(concat_ws('|',s.sequence_name,s.data_type,s.start_value,s.minimum_value,s.maximum_value,s.increment,s.cycle_option),E'\\n' ORDER BY s.sequence_name) v
 FROM information_schema.sequences s WHERE s.sequence_schema='public' AND (
  s.sequence_name LIKE 'tron_transfer_wallet_accounts%' OR s.sequence_name LIKE 'tron_transfer_owner_operations%' OR s.sequence_name LIKE 'tron_transfer_deployments%' OR s.sequence_name LIKE 'tron_transfer_wallet_recovery_tokens%' OR s.sequence_name LIKE 'tron_transfer_pending_owner_%'
 )
), trig AS (
 SELECT string_agg(concat_ws('|',c.relname,t.tgname,pg_get_triggerdef(t.oid)),E'\\n' ORDER BY c.relname,t.tgname) v
 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN target x ON x.table_name=c.relname WHERE NOT t.tgisinternal
), policies AS (
 SELECT string_agg(concat_ws('|',tablename,policyname,permissive,roles,cmd,qual,with_check),E'\\n' ORDER BY tablename,policyname) v
 FROM pg_policies p JOIN target t ON t.table_name=p.tablename WHERE schemaname='public'
), funcs AS (
 SELECT string_agg(concat_ws('|',p.proname,pg_get_function_identity_arguments(p.oid),pg_get_functiondef(p.oid)),E'\\n' ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)) v
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'tron_transfer_%'
), tables AS (
 SELECT string_agg(concat_ws('|',c.relname,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,COALESCE(array_to_string(c.reloptions,','),'')),E'\\n' ORDER BY c.relname) v
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN target t ON t.table_name=c.relname WHERE n.nspname='public'
)
SELECT encode(sha256(convert_to(concat_ws(E'\\n',cols.v,cons.v,idx.v,seqs.v,trig.v,policies.v,funcs.v,tables.v),'UTF8')),'hex') AS fingerprint
FROM cols,cons,idx,seqs,trig,policies,funcs,tables`

export async function getOwnerAdminSchemaFingerprint(client) {
  const result = await client.query(OWNER_ADMIN_SCHEMA_FINGERPRINT_SQL)
  return String(result.rows?.[0]?.fingerprint || '').trim()
}

export function assertOwnerAdminMigrationSafety(env = process.env) {
  if (env.OWNER_ADMIN_MIGRATIONS_ACK !== ACK) {
    throw new Error('Set OWNER_ADMIN_MIGRATIONS_ACK=' + ACK + ' only after a verified Neon backup and restore drill.')
  }
  if (env.OWNER_OPERATION_LEDGER_BACKUP_VERIFIED !== 'true') {
    throw new Error('Owner Admin migration blocked: set OWNER_OPERATION_LEDGER_BACKUP_VERIFIED=true only after verifying a recoverable production backup.')
  }
  if (env.OWNER_OPERATION_LEDGER_RESTORE_TESTED !== 'true') {
    throw new Error('Owner Admin migration blocked: set OWNER_OPERATION_LEDGER_RESTORE_TESTED=true only after completing and recording a successful restore drill.')
  }
}

export async function applyOwnerAdminMigrations(client, migrations, validate = null, {
  legacyChecksums = LEGACY_MIGRATION_CHECKSUMS,
  expectedSchemaFingerprint = OWNER_ADMIN_SCHEMA_FINGERPRINT,
  readSchemaFingerprint = getOwnerAdminSchemaFingerprint,
} = {}) {
  const applied = [], skipped = []
  let legacySchemaVerified = false
  await client.query('BEGIN')
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('tron-transfer-owner-admin-migrations'))")
    await client.query("CREATE TABLE IF NOT EXISTS public.tron_transfer_owner_admin_schema_migrations (version TEXT PRIMARY KEY, checksum CHAR(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'), applied_at TIMESTAMPTZ NOT NULL DEFAULT now())")
    for (const migration of migrations) {
      const checksum = createHash('sha256').update(migration.sql).digest('hex')
      const prior = await client.query('SELECT checksum FROM public.tron_transfer_owner_admin_schema_migrations WHERE version=$1', [migration.version])
      if (prior.rows?.[0]) {
        const priorChecksum = String(prior.rows[0].checksum || '').trim()
        if (priorChecksum !== checksum) {
          const knownLegacyChecksum = legacyChecksums[migration.version]
          const acceptedLegacyChecksums = Array.isArray(knownLegacyChecksum) ? knownLegacyChecksum : [knownLegacyChecksum]
          if (!acceptedLegacyChecksums.some(value => typeof value === 'string' && priorChecksum === value)) {
            throw new Error('Applied migration checksum changed: ' + migration.version)
          }
          if (!legacySchemaVerified) {
            const fingerprint = await readSchemaFingerprint(client)
            if (fingerprint !== expectedSchemaFingerprint) {
              throw new Error('Legacy migration checksum cannot be reconciled because the Owner Admin schema fingerprint does not match the verified production schema.')
            }
            legacySchemaVerified = true
          }
          await client.query(
            'UPDATE public.tron_transfer_owner_admin_schema_migrations SET checksum=$1 WHERE version=$2 AND checksum=$3',
            [checksum, migration.version, priorChecksum],
          )
        }
        skipped.push(migration.version)
        continue
      }
      await client.query(stripOuterTransactionEnvelope(migration.sql))
      await client.query('INSERT INTO public.tron_transfer_owner_admin_schema_migrations (version,checksum) VALUES ($1,$2)', [migration.version, checksum])
      applied.push(migration.version)
    }
    const validation = typeof validate === 'function' ? await validate(client) : null
    await client.query('COMMIT')
    return { applied, skipped, validation, legacyChecksumsReconciled: legacySchemaVerified }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }
}
async function main() {
  assertOwnerAdminMigrationSafety(process.env)
  const connection = process.env.OWNER_ADMIN_DATABASE_URL || process.env.SPONSOR_DATABASE_URL || process.env.DATABASE_URL
  if (!connection) throw new Error('Set OWNER_ADMIN_DATABASE_URL, SPONSOR_DATABASE_URL, or DATABASE_URL to the direct PostgreSQL URL. Values are never printed.')
  try {
    assertOwnerAdminDatabaseIdentity(connection, process.env.OWNER_ADMIN_EXPECTED_DATABASE_IDENTITY_SHA256)
  } catch (error) {
    if (error?.message === 'missing-owner-admin-database-identity-pin') throw new Error('Set OWNER_ADMIN_EXPECTED_DATABASE_IDENTITY_SHA256 to the independently verified target database fingerprint before applying migrations.')
    if (error?.message === 'owner-admin-database-identity-mismatch') throw new Error('Owner Admin migration target database identity does not match the pinned production target; no migration was applied.')
    throw error
  }
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
    const result = await applyOwnerAdminMigrations(client, migrations, async transactionClient => {
      const check = await transactionClient.query("SELECT to_regclass('public.tron_transfer_wallet_accounts') IS NOT NULL AS wallet_accounts, to_regclass('public.tron_transfer_wallet_sessions') IS NOT NULL AS wallet_sessions, to_regclass('public.tron_transfer_owner_operations') IS NOT NULL AS owner_operations, to_regclass('public.tron_transfer_deployments') IS NOT NULL AS trax_deployments, to_regclass('public.tron_transfer_wallet_recovery_tokens') IS NOT NULL AS recovery_tokens, to_regclass('public.tron_transfer_pending_owner_sessions') IS NOT NULL AS pending_owner_sessions, to_regclass('public.tron_transfer_pending_owner_acceptances') IS NOT NULL AS pending_owner_acceptances, (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tron_transfer_wallet_recovery_tokens' AND column_name='wallet_role')) AS recovery_role_scope, (SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.tron_transfer_owner_operations'::regclass AND conname='tron_transfer_owner_operations_operation_type_check' AND pg_get_constraintdef(oid) LIKE '%usdt-transfer%')) AS official_usdt_withdrawal_operation")
      const checks = check.rows?.[0] || {}
      const missing = Object.entries(checks).filter(([, value]) => value !== true).map(([name]) => name)
      if (missing.length) throw new Error('Migration postflight is missing required tables: ' + missing.join(', '))
      return checks
    })
    process.stdout.write(JSON.stringify({ success: true, applied: result.applied, alreadyApplied: result.skipped, postflight: result.validation, note: 'No credentials, connection details, row contents or wallet keys were printed.' }) + '\n')
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
