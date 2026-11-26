import assert from 'node:assert/strict'
import { test } from 'node:test'
import pg from 'pg'
import {
  getOwnerAdminSchemaFingerprint,
  OWNER_ADMIN_SCHEMA_FINGERPRINT,
} from '../scripts/migrate-owner-admin-ledgers.mjs'

const PROJECT_ID = 'super-water-26874320'
const EXPECTED_BRANCH_NAME = 'tron-transfer-restore-acceptance-2026-11-26'
const EXPECTED_SNAPSHOT_ID = 'snap-crimson-mouse-beya8lz8'
const PRODUCTION_BRANCH_ID = 'br-proud-mud-bexgns9g'
const SIGNER_ACCEPTANCE_MIGRATION = '20261126_wallet_signer_acceptance_audit.sql'
const SIGNER_ACCEPTANCE_INDEX = 'tron_transfer_wallet_auth_audit_signer_acceptance'
const SIGNER_ACCEPTANCE_EVENT = 'signer_acceptance_verified'
const BASELINE_FINGERPRINT = 'd791bd80a73d966365e717ac7f72e1525f4df1c2fac1d0096c2f8aea5c5ad8ea'

const databaseUrl = process.env.OWNER_ADMIN_FINGERPRINT_TEST_DATABASE_URL
const neonApiKey = process.env.NEON_API_KEY
const projectId = process.env.OWNER_ADMIN_FINGERPRINT_TEST_PROJECT_ID
const branchId = process.env.OWNER_ADMIN_FINGERPRINT_TEST_BRANCH_ID
const branchName = process.env.OWNER_ADMIN_FINGERPRINT_TEST_BRANCH_NAME
const configured = Boolean(databaseUrl && neonApiKey && projectId && branchId && branchName)

function assertDirectDatabaseUrl(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('OWNER_ADMIN_FINGERPRINT_TEST_DATABASE_URL must be a valid direct PostgreSQL URL.')
  }
  assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol), 'Expected a PostgreSQL URL.')
  assert.ok(parsed.hostname, 'The test database URL must include a hostname.')
  assert.ok(!parsed.hostname.includes('-pooler.'), 'The restore integration test must use a direct endpoint, not a pooler.')
  assert.notEqual(parsed.hostname.split('.')[0], '', 'The Neon endpoint hostname must identify an endpoint.')
  return parsed
}

async function neonGet(path) {
  const response = await fetch(`https://console.neon.tech/api/v2${path}`, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${neonApiKey}`,
    },
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) {
    throw new Error(`Neon identity verification failed (HTTP ${response.status}); refusing database access.`)
  }
  return response.json()
}

function unwrap(payload, key) {
  return payload?.[key] && typeof payload[key] === 'object' ? payload[key] : payload
}

async function verifyRestoredBranchIdentity(parsedUrl) {
  assert.equal(projectId, PROJECT_ID, 'The test is restricted to the configured non-production Neon project.')
  assert.equal(branchName, EXPECTED_BRANCH_NAME, 'The branch name must match the dedicated restore-test fixture.')
  assert.match(branchId, /^br-[a-z0-9-]+$/, 'A Neon branch ID is required.')
  assert.notEqual(branchId, PRODUCTION_BRANCH_ID, 'Production branch access is prohibited.')

  const endpointId = parsedUrl.hostname.split('.')[0]
  assert.match(endpointId, /^ep-[a-z0-9-]+$/, 'The database hostname must identify a Neon endpoint.')

  const [endpointPayload, branchPayload] = await Promise.all([
    neonGet(`/projects/${PROJECT_ID}/endpoints/${endpointId}`),
    neonGet(`/projects/${PROJECT_ID}/branches/${branchId}`),
  ])
  const endpoint = unwrap(endpointPayload, 'endpoint')
  const branch = unwrap(branchPayload, 'branch')

  assert.equal(endpoint.id, endpointId, 'Neon endpoint ID does not match the database URL.')
  assert.equal(endpoint.project_id, PROJECT_ID, 'Neon endpoint belongs to a different project.')
  assert.equal(endpoint.branch_id, branchId, 'Database endpoint is attached to a different branch.')
  assert.equal(branch.id, branchId, 'Neon returned a different branch ID.')
  assert.equal(branch.project_id, PROJECT_ID, 'Restore branch belongs to a different project.')
  assert.equal(branch.name, EXPECTED_BRANCH_NAME, 'Connected branch is not the dedicated restore-test fixture.')
  assert.equal(branch.default, false, 'The restore-test branch must not be the project default/production branch.')
  assert.equal(branch.parent_id ?? null, null, 'The restore fixture must be an isolated snapshot restore, not a child of production.')
  assert.equal(branch.restored_from, EXPECTED_SNAPSHOT_ID, 'The restore fixture must come from the verified post-signer production snapshot.')
  assert.equal(branch.current_state ?? branch.state, 'ready', 'The restore-test branch must be ready before connecting.')

  return { endpointId, branchId: branch.id }
}

test('Owner Admin fingerprint matches the post-signer production baseline on an identity-verified Neon restore', {
  skip: configured ? false : 'Set the five OWNER_ADMIN_FINGERPRINT_TEST_* / NEON_API_KEY variables to run the isolated restore integration test.',
  timeout: 60000,
}, async () => {
  const parsedUrl = assertDirectDatabaseUrl(databaseUrl)
  const identity = await verifyRestoredBranchIdentity(parsedUrl)

  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 10000,
    query_timeout: 20000,
    statement_timeout: 20000,
    application_name: 'owner-admin-fingerprint-restore-readonly-test',
    ssl: parsedUrl.searchParams.get('sslmode') === 'disable' ? false : undefined,
  })

  let transactionOpen = false
  try {
    await client.connect()
    await client.query('BEGIN READ ONLY')
    transactionOpen = true
    const readOnly = await client.query('SHOW transaction_read_only')
    assert.equal(readOnly.rows[0]?.transaction_read_only, 'on', 'The PostgreSQL transaction must be read-only.')

    const migrationLedger = await client.query(
      "SELECT to_regclass('public.tron_transfer_owner_admin_schema_migrations') IS NOT NULL AS present",
    )
    assert.equal(migrationLedger.rows[0]?.present, true, 'Owner Admin migration ledger is missing from the restore.')

    const signerMigration = await client.query(
      'SELECT EXISTS (SELECT 1 FROM public.tron_transfer_owner_admin_schema_migrations WHERE version = $1) AS present',
      [SIGNER_ACCEPTANCE_MIGRATION],
    )
    assert.equal(signerMigration.rows[0]?.present, true, 'The production baseline must include the signer-acceptance audit migration.')

    const signerIndex = await client.query(
      'SELECT to_regclass($1) IS NOT NULL AS present',
      [`public.${SIGNER_ACCEPTANCE_INDEX}`],
    )
    assert.equal(signerIndex.rows[0]?.present, true, 'The production baseline must include the signer-acceptance partial index.')

    const signerConstraint = await client.query(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'public.tron_transfer_wallet_auth_audit'::regclass
          AND conname = 'tron_transfer_wallet_auth_audit_event_type_check'`,
    )
    assert.equal(signerConstraint.rowCount, 1, 'The wallet auth audit event-type constraint must exist.')
    assert.ok(
      String(signerConstraint.rows[0].definition).includes(SIGNER_ACCEPTANCE_EVENT),
      'The production baseline constraint must allow the signer-acceptance event.',
    )

    const actualFingerprint = await getOwnerAdminSchemaFingerprint(client)
    assert.equal(actualFingerprint, BASELINE_FINGERPRINT, 'The restored branch does not match the independently verified production fingerprint.')
    assert.equal(actualFingerprint, OWNER_ADMIN_SCHEMA_FINGERPRINT, 'The committed migration runner baseline fingerprint has changed.')
    assert.deepEqual(identity, { endpointId: parsedUrl.hostname.split('.')[0], branchId })

  } finally {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => {})
    await client.end().catch(() => {})
  }
})
