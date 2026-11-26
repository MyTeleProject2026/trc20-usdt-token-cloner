import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createSponsorResourceApi, databaseTargetIdentityMatches, sponsorDatabaseConnectionInfo, sponsorDatabaseConnectionString, sponsorDatabaseTargetIdentityInfo, walletAuthDatabaseConnectionString } from '../sponsor-api.mjs'
import { normalizePostgresTlsMode } from '../scripts/sponsor-ledger-database-identity.mjs'

const SPONSOR = 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL'
const OWNER = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const SECRET = 'test-session-secret-with-at-least-thirty-two-bytes'
const SPONSOR_LEDGER_MIGRATION_SHA256 = 'cb2f2a8e1eba285dc196dbc904c68996bdaf64b9c11d80bd56a87a5866d5d32a'
const SIGNATURE = 'a'.repeat(130)
const OWNER_SESSION_FIXTURE = 'test-admin-token-with-at-least-thirty-two-bytes'

function request(method, path, body, token, ownerSessionFixture, client = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  stream.method = method
  stream.url = path
  stream.headers = { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(ownerSessionFixture ? { 'x-test-owner-admin-session': 'valid' } : {}), ...(client.headers || {}) }
  stream.socket = { remoteAddress: client.remoteAddress || '127.0.0.1' }
  return stream
}
function response() {
  return { status: 0, payload: null }
}
function setup({ database = null, engine = null, ownerSessionFixture = OWNER_SESSION_FIXTURE, databaseUrl = '', expectedDatabaseIdentitySha256 = '', migrationChecksum = SPONSOR_LEDGER_MIGRATION_SHA256, authenticateManagedSession = null, authenticateOwnerAdminSession = async req => req.headers?.['x-test-owner-admin-session'] === 'valid' ? { address: OWNER } : null } = {}) {
  let clock = Date.now()
  const env = {
    SPONSOR_SESSION_SECRET: SECRET,
    SPONSOR_LEDGER_DURABLE: 'true',
    SPONSOR_LEDGER_BACKUP_VERIFIED: 'true',
    SPONSOR_LEDGER_RESTORE_TESTED: 'true',
    SPONSOR_MAINNET_ADDRESS: SPONSOR,
    TRON_OWNER_ADDRESS: OWNER,
    ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
    ...(expectedDatabaseIdentitySha256 ? { OWNER_ADMIN_EXPECTED_DATABASE_IDENTITY_SHA256: expectedDatabaseIdentitySha256 } : {}),
    SPONSOR_TRANSACTION_ENGINE_ENABLED: 'false',
    SPONSOR_MAINNET_BROADCAST_ENABLED: 'false',
  }
  const calls = []
  const wrapDatabaseClient = client => ({
    query: async (sql, values) => {
      if (String(sql).includes('SELECT checksum FROM public.tron_transfer_owner_admin_schema_migrations')) {
        return migrationChecksum ? { rowCount: 1, rows: [{ checksum: migrationChecksum }] } : { rowCount: 0, rows: [] }
      }
      return client.query(sql, values)
    },
    ...(typeof client.release === 'function' ? { release: (...args) => client.release(...args) } : {}),
  })
  const testDatabase = database ? {
    ...wrapDatabaseClient(database),
    ...(typeof database.connect === 'function' ? { connect: async () => wrapDatabaseClient(await database.connect()) } : {}),
  } : null
  const api = createSponsorResourceApi({
    env,
    allowedAddress: OWNER,
    getDatabase: () => testDatabase,
    ...(authenticateManagedSession ? { authenticateManagedSession } : {}),
    ...(authenticateOwnerAdminSession ? { authenticateOwnerAdminSession } : {}),
    engine: engine || {
      readiness: () => ({
        configured: false,
        enabled: false,
        broadcastAvailable: false,
        clientSigningAvailable: false,
        stakingPolicy: { enabled: false, maxStakeTrx: '0' },
        ownerTopupPolicy: { enabled: false, maxTopupTrx: '0' },
        feePolicy: {},
      }),
      execute: async () => { calls.push('execute'); return { success: true } },
      reconcile: async () => ({ confirmed: false, status: 'not-solidified' }),
    },
    verifyMessage: async (message, signature) => signature === SIGNATURE ? SPONSOR : '',
    send: (res, status, payload) => { res.status = status; res.payload = payload },
    now: () => clock,
  })
  return { api, calls, env, advanceClock: milliseconds => { clock += milliseconds } }
}
async function call(api, method, path, body, token, ownerSessionFixture = OWNER_SESSION_FIXTURE, client = {}) {
  const res = response()
  const handled = await api.handle(request(method, path, body, token, ownerSessionFixture, client), res, new URL(path, 'http://localhost'), null)
  assert.equal(handled, true)
  return res
}
async function authenticated(api) {
  const challenge = await call(api, 'POST', '/api/sponsor/session/challenge', { address: SPONSOR })
  assert.equal(challenge.status, 201)
  const verified = await call(api, 'POST', '/api/sponsor/session/verify', {
    address: SPONSOR, nonce: challenge.payload.nonce, signature: SIGNATURE,
  })
  assert.equal(verified.status, 200)
  return verified.payload.token
}

test('Sponsor database status identifies the selected URL source and provider without exposing connection details', async () => {
  const env = {
    SPONSOR_DATABASE_URL_POOLED: 'postgres://neon_user:neon_secret@ep-example-pooler.ap-southeast-1.aws.neon.tech/sponsor?sslmode=require',
    SPONSOR_DATABASE_URL: 'postgres://neon_user:neon_secret@ep-example.ap-southeast-1.aws.neon.tech/sponsor?sslmode=require',
    DATABASE_URL_POOLED: 'postgres://legacy:secret@old-neon-pooler.example/sponsor',
  }
  assert.deepEqual(sponsorDatabaseConnectionInfo(env), {
    configured: true,
    sourceVariable: 'SPONSOR_DATABASE_URL_POOLED',
    provider: 'neon',
    connectionMode: 'pooled',
    identityFingerprint: sponsorDatabaseConnectionInfo({ SPONSOR_DATABASE_URL_POOLED: env.SPONSOR_DATABASE_URL_POOLED }).identityFingerprint,
  })
  assert.equal(sponsorDatabaseConnectionString(env), env.SPONSOR_DATABASE_URL_POOLED)

  const direct = sponsorDatabaseConnectionInfo({ DATABASE_URL: 'postgres://user:password@db.render.com/sponsor' })
  assert.deepEqual(direct, {
    configured: true,
    sourceVariable: 'DATABASE_URL',
    provider: 'render-postgres',
    connectionMode: 'direct',
    identityFingerprint: sponsorDatabaseConnectionInfo({ DATABASE_URL: 'postgres://user:password@db.render.com/sponsor' }).identityFingerprint,
  })
  assert.deepEqual(sponsorDatabaseConnectionInfo({}), {
    configured: false,
    sourceVariable: null,
    provider: 'not-configured',
    connectionMode: 'unknown',
  })
})

test('database identity fingerprint excludes passwords but changes with endpoint, database, or role', () => {
  const first = sponsorDatabaseConnectionInfo({ DATABASE_URL: 'postgres://app_user:first-secret@ep-a.ap-southeast-1.aws.neon.tech/tron-transfer?sslmode=require' })
  const passwordRotation = sponsorDatabaseConnectionInfo({ DATABASE_URL: 'postgres://app_user:second-secret@ep-a.ap-southeast-1.aws.neon.tech/tron-transfer?sslmode=require' })
  const otherBranch = sponsorDatabaseConnectionInfo({ DATABASE_URL: 'postgres://app_user:first-secret@ep-b.ap-southeast-1.aws.neon.tech/tron-transfer?sslmode=require' })
  const otherDatabase = sponsorDatabaseConnectionInfo({ DATABASE_URL: 'postgres://app_user:first-secret@ep-a.ap-southeast-1.aws.neon.tech/other-db?sslmode=require' })
  const otherRole = sponsorDatabaseConnectionInfo({ DATABASE_URL: 'postgres://other_user:first-secret@ep-a.ap-southeast-1.aws.neon.tech/tron-transfer?sslmode=require' })
  assert.equal(first.identityFingerprint, passwordRotation.identityFingerprint)
  assert.notEqual(first.identityFingerprint, otherBranch.identityFingerprint)
  assert.notEqual(first.identityFingerprint, otherDatabase.identityFingerprint)
  assert.notEqual(first.identityFingerprint, otherRole.identityFingerprint)
})

test('approved direct Neon target must match the actual Sponsor runtime connection, including pooled host normalization', () => {
  const direct = 'postgresql://app_user:secret@ep-production.c-9.us-east-2.aws.neon.tech/tron-transfer?sslmode=require'
  const pooled = 'postgresql://app_user:secret@ep-production-pooler.c-9.us-east-2.aws.neon.tech/tron-transfer?sslmode=require'
  const expected = sponsorDatabaseConnectionInfo({ DATABASE_URL: direct }).identityFingerprint

  assert.equal(sponsorDatabaseConnectionInfo({ DATABASE_URL: pooled }).identityFingerprint, expected)
  assert.equal(databaseTargetIdentityMatches({
    DATABASE_URL: pooled,
    OWNER_ADMIN_DATABASE_URL: direct,
    OWNER_ADMIN_EXPECTED_DATABASE_IDENTITY_SHA256: expected,
  }), true)

  const wrongRuntime = 'postgresql://app_user:secret@ep-other-pooler.c-9.us-east-2.aws.neon.tech/tron-transfer?sslmode=require'
  assert.equal(databaseTargetIdentityMatches({
    DATABASE_URL: wrongRuntime,
    OWNER_ADMIN_DATABASE_URL: direct,
    OWNER_ADMIN_EXPECTED_DATABASE_IDENTITY_SHA256: expected,
  }), false, 'an approved direct URL must not mask a different Sponsor runtime database')
})

test('production acceptance requires an exact configured database identity fingerprint', async () => {
  const databaseUrl = 'postgres://neon_user:neon_secret@ep-production.ap-southeast-1.aws.neon.tech/tron-transfer?sslmode=require'
  const expected = sponsorDatabaseConnectionInfo({ DATABASE_URL: databaseUrl }).identityFingerprint
  const matched = setup({ databaseUrl, expectedDatabaseIdentitySha256: expected })
  const matchResult = await call(matched.api, 'GET', '/api/acceptance/production')
  assert.equal(matchResult.status, 200)
  assert.equal(matchResult.payload.databaseIdentityMatches, true)
  assert.equal(matchResult.payload.expectedDatabaseIdentityConfigured, true)
  assert.equal(matchResult.payload.acceptance.checks.find(check => check.id === 'database-target-identity').state, 'passed')

  const mismatched = setup({ databaseUrl, expectedDatabaseIdentitySha256: 'f'.repeat(64) })
  const mismatchResult = await call(mismatched.api, 'GET', '/api/acceptance/production')
  assert.equal(mismatchResult.payload.databaseIdentityMatches, false)
  assert.equal(mismatchResult.payload.acceptance.checks.find(check => check.id === 'database-target-identity').state, 'blocked')
  const serialized = JSON.stringify(matchResult.payload)
  assert.equal(serialized.includes('ep-production'), false)
  assert.equal(serialized.includes('neon_secret'), false)
})

test('production acceptance blocks when the Sponsor runtime URL differs from the approved direct Neon endpoint', async () => {
  const direct = 'postgresql://app_user:secret@ep-approved.c-9.us-east-2.aws.neon.tech/tron-transfer?sslmode=require'
  const wrongRuntime = 'postgresql://app_user:secret@ep-unapproved.c-9.us-east-2.aws.neon.tech/tron-transfer?sslmode=require'
  const expected = sponsorDatabaseConnectionInfo({ DATABASE_URL: direct }).identityFingerprint
  const fixture = setup({ databaseUrl: wrongRuntime, expectedDatabaseIdentitySha256: expected })
  fixture.env.OWNER_ADMIN_DATABASE_URL = direct

  const result = await call(fixture.api, 'GET', '/api/acceptance/production')
  assert.equal(result.payload.databaseIdentityMatches, false)
  assert.equal(result.payload.acceptance.checks.find(check => check.id === 'database-target-identity').state, 'blocked')
})

test('Sponsor transaction preparation is blocked when the configured database identity does not match the approved target', async () => {
  const databaseUrl = 'postgres://neon_user:secret@ep-production.ap-southeast-1.aws.neon.tech/tron-transfer?sslmode=require'
  const { api } = setup({ databaseUrl, expectedDatabaseIdentitySha256: 'f'.repeat(64) })
  const token = await authenticated(api)
  const intent = await call(api, 'POST', '/api/sponsor/intent', {
    operation: 'delegate', resource: 'ENERGY', amountSun: '1000000',
    idempotencyKey: 'sponsor-db-identity-mismatch-0123456789',
  }, token)
  assert.equal(intent.status, 201)
  const prepared = await call(api, 'POST', '/api/sponsor/operations/prepare', {
    intentId: intent.payload.intentId, confirmPhrase: intent.payload.confirmationPhrase,
  }, token)
  assert.equal(prepared.status, 503)
  assert.equal(prepared.payload.error, 'sponsor-ledger-database-identity-not-accepted')
})

test('Sponsor status reports selected database source but never returns hostnames or credentials', async () => {
  const secretUrl = 'postgres://neon_user:neon_secret@ep-private.ap-southeast-1.aws.neon.tech/sponsor?sslmode=require'
  const { api } = setup({ databaseUrl: secretUrl })
  const result = await call(api, 'GET', '/api/sponsor/status')
  assert.equal(result.status, 200)
  assert.deepEqual(result.payload.databaseConnection, {
    configured: true,
    sourceVariable: 'DATABASE_URL',
    provider: 'neon',
    connectionMode: 'direct',
    identityFingerprint: sponsorDatabaseConnectionInfo({ DATABASE_URL: secretUrl }).identityFingerprint,
  })
  assert.equal(result.payload.databaseIdentityMatches, false)
  assert.equal(result.payload.expectedDatabaseIdentityConfigured, false)
  assert.equal(result.payload.acceptance.checks.find(check => check.id === 'database-target-identity').state, 'blocked')
  const serialized = JSON.stringify(result.payload)
  assert.equal(serialized.includes('neon_secret'), false)
  assert.equal(serialized.includes('ep-private'), false)
  assert.equal(serialized.includes('neon.tech'), false)
})


test('Sponsor API rate limits use validated Cloudflare client IPs, not caller-controlled forwarding headers', async () => {
  const { api } = setup()
  const firstClient = { headers: { 'cf-connecting-ip': '198.51.100.10', 'x-forwarded-for': '203.0.113.77' } }
  const results = []
  for (let index = 0; index < 9; index += 1) {
    results.push(await call(api, 'POST', '/api/sponsor/session/challenge', { address: SPONSOR }, null, OWNER_SESSION_FIXTURE, firstClient))
  }
  assert.deepEqual(results.slice(0, 8).map(result => result.status), Array(8).fill(201))
  assert.equal(results[8].status, 429)
  const secondClient = { headers: { 'cf-connecting-ip': '198.51.100.11', 'x-forwarded-for': '203.0.113.77' } }
  const second = await call(api, 'POST', '/api/sponsor/session/challenge', { address: SPONSOR }, null, OWNER_SESSION_FIXTURE, secondClient)
  assert.equal(second.status, 201)
})

test('Sponsor-specific database URLs take precedence over shared application URLs', () => {
  assert.equal(
    sponsorDatabaseConnectionString({
      SPONSOR_DATABASE_URL_POOLED: 'postgres://sponsor-pooled',
      SPONSOR_DATABASE_URL: 'postgres://sponsor-direct',
      DATABASE_URL_POOLED: 'postgres://shared-pooled',
      DATABASE_URL: 'postgres://shared-direct',
    }),
    'postgres://sponsor-pooled',
  )
  assert.equal(
    sponsorDatabaseConnectionString({
      SPONSOR_DATABASE_URL: 'postgres://sponsor-direct',
      DATABASE_URL_POOLED: 'postgres://shared-pooled',
      DATABASE_URL: 'postgres://shared-direct',
    }),
    'postgres://sponsor-direct',
  )
  assert.equal(
    sponsorDatabaseConnectionString({
      DATABASE_URL_POOLED: 'postgres://shared-pooled',
      DATABASE_URL: 'postgres://shared-direct',
    }),
    'postgres://shared-pooled',
  )
})

test('wallet authentication prioritizes the explicitly pinned Owner Admin database over generic runtime URLs', () => {
  const ownerAdmin = 'postgres://owner_admin:secret@ep-curly-cherry-bej1ybw8.c-9.us-east-2.aws.neon.tech/Tron%20Transfer%20Resource%20Database%20?sslmode=require'
  const unrelatedRuntime = 'postgres://render_app:secret@dpg-unrelated.render.com/appdb'
  assert.equal(walletAuthDatabaseConnectionString({
    OWNER_ADMIN_DATABASE_URL: ownerAdmin,
    DATABASE_URL: unrelatedRuntime,
    DATABASE_URL_POOLED: unrelatedRuntime,
    SPONSOR_DATABASE_URL: unrelatedRuntime,
  }), ownerAdmin)
  assert.equal(walletAuthDatabaseConnectionString({
    DATABASE_URL: unrelatedRuntime,
  }), unrelatedRuntime)
  assert.equal(walletAuthDatabaseConnectionString({}), null)
})

test('pinned Owner Admin direct Neon URL is the runtime fallback when shared database URLs are absent', () => {
  const direct = 'postgres://owner_admin:secret@ep-curly-cherry-bej1ybw8.c-9.us-east-2.aws.neon.tech/Tron%20Transfer%20Resource%20Database%20?sslmode=require'
  const env = {
    OWNER_ADMIN_DATABASE_URL: direct,
    OWNER_ADMIN_EXPECTED_DATABASE_IDENTITY_SHA256: sponsorDatabaseTargetIdentityInfo({ OWNER_ADMIN_DATABASE_URL: direct }).identityFingerprint,
  }
  assert.equal(sponsorDatabaseConnectionString(env), direct)
  assert.equal(sponsorDatabaseConnectionInfo(env).sourceVariable, 'OWNER_ADMIN_DATABASE_URL')
  assert.equal(databaseTargetIdentityMatches(env), true)
  assert.equal(databaseTargetIdentityMatches({
    ...env,
    DATABASE_URL: 'postgres://other:secret@ep-other.ap-southeast-1.aws.neon.tech/other-db',
  }), false, 'an explicitly configured but different runtime URL must not be masked by the Owner Admin fallback')
})

test('Sponsor status exposes readiness but never secret values', async () => {
  const { api } = setup()
  const result = await call(api, 'GET', '/api/sponsor/status')
  assert.equal(result.status, 200)
  assert.equal(result.payload.network, 'TRON Mainnet')
  assert.equal(result.payload.sponsorAddress, SPONSOR)
  assert.equal(result.payload.transactionExecutionAvailable, false)
  assert.equal(result.payload.broadcastAvailable, false)
  assert.equal(result.payload.clientSigningAvailable, false)
  assert.equal(result.payload.stakingPolicy.enabled, false)
  assert.equal(result.payload.ownerTopupPolicy.enabled, false)
  assert.equal(result.payload.databaseReady, false)
  assert.equal(result.payload.databaseStatus, 'not-configured')
  assert.equal(result.payload.sponsorWritesPaused, true)
  assert.equal(JSON.stringify(result.payload).includes(SECRET), false)
})


test('Sponsor status reports a missing ledger schema without attempting DDL', async () => {
  const calls = []
  const database = {
    async query(sql) {
      calls.push(sql)
      assert.match(sql, /to_regclass/)
      return { rowCount: 1, rows: [{ operations_table: null, control_table: null }] }
    },
  }
  const databaseUrl = 'postgres://test_user:test_password@ep-test.ap-southeast-1.aws.neon.tech/sponsor?sslmode=require'
  const expectedDatabaseIdentitySha256 = sponsorDatabaseConnectionInfo({ DATABASE_URL: databaseUrl }).identityFingerprint
  const { api } = setup({ database, databaseUrl, expectedDatabaseIdentitySha256 })
  const result = await call(api, 'GET', '/api/sponsor/status')
  assert.equal(result.status, 200)
  assert.equal(result.payload.databaseConfigured, true)
  assert.equal(result.payload.databaseReady, false)
  assert.equal(result.payload.databaseStatus, 'schema-missing')
  assert.equal(result.payload.sponsorWritesPaused, true)
  assert.equal(result.payload.transactionExecutionAvailable, false)
  assert.equal(calls.length, 2)
  assert.match(calls[0], /SELECT wallet_role, wallet_address, enabled/)
  assert.match(calls[1], /to_regclass/)
  assert.equal(calls.some(sql => /^\\s*(CREATE|ALTER|DROP|INSERT|UPDATE)\\b/im.test(sql)), false)
})

test('Sponsor ledger bootstrap requires admin authorization and explicit confirmation and leaves writes paused', async () => {
  let schemaCreated = false
  const database = {
    async query(sql) {
      if (sql.includes('CREATE TABLE IF NOT EXISTS public.tron_transfer_sponsor_operations')) {
        schemaCreated = true
        return { rowCount: 0, rows: [] }
      }
      if (sql.includes('SELECT writes_paused')) return { rowCount: 1, rows: [{ writes_paused: true }] }
      throw new Error('unexpected bootstrap query')
    },
  }
  const databaseUrl = 'postgres://test_user:test_password@ep-test.ap-southeast-1.aws.neon.tech/sponsor?sslmode=require'
  const expectedDatabaseIdentitySha256 = sponsorDatabaseConnectionInfo({ DATABASE_URL: databaseUrl }).identityFingerprint
  const { api } = setup({ database, databaseUrl, expectedDatabaseIdentitySha256 })
  const denied = await call(api, 'POST', '/api/sponsor/ledger/bootstrap', {}, null, '')
  assert.equal(denied.status, 401)
  assert.equal(schemaCreated, false)

  const missingConfirmation = await call(api, 'POST', '/api/sponsor/ledger/bootstrap', {}, null, OWNER_SESSION_FIXTURE)
  assert.equal(missingConfirmation.status, 400)
  assert.equal(missingConfirmation.payload.error, 'explicit-ledger-bootstrap-confirmation-required')
  assert.equal(schemaCreated, false)

  const initialized = await call(api, 'POST', '/api/sponsor/ledger/bootstrap', { confirm: 'INITIALIZE_SPONSOR_LEDGER_SCHEMA' }, null, OWNER_SESSION_FIXTURE)
  assert.equal(initialized.status, 200)
  assert.equal(initialized.payload.schemaInitialized, true)
  assert.equal(initialized.payload.databaseReady, true)
  assert.equal(initialized.payload.sponsorWritesPaused, true)
  assert.equal(initialized.payload.transactionExecutionAvailable, false)
  assert.equal(schemaCreated, true)
})

test('managed Owner Admin authorization for Sponsor bootstrap requires the CSRF-protected Owner session', async () => {
  let schemaCreated = false
  const database = {
    async query(sql) {
      if (sql.includes('CREATE TABLE IF NOT EXISTS public.tron_transfer_sponsor_operations')) {
        schemaCreated = true
        return { rowCount: 0, rows: [] }
      }
      if (sql.includes('SELECT writes_paused')) return { rowCount: 1, rows: [{ writes_paused: true }] }
      throw new Error('unexpected bootstrap query')
    },
  }
  const databaseUrl = 'postgres://test_user:test_password@ep-test.ap-southeast-1.aws.neon.tech/sponsor?sslmode=require'
  const expectedDatabaseIdentitySha256 = sponsorDatabaseConnectionInfo({ DATABASE_URL: databaseUrl }).identityFingerprint
  const { api } = setup({
    database,
    databaseUrl,
    expectedDatabaseIdentitySha256,
    ownerSessionFixture: '',
    authenticateOwnerAdminSession: async (req, options) => {
      assert.equal(options.requireCsrf, true)
      const valid = String(req.headers.cookie || '').includes('tron_owner_session=owner-session')
        && req.headers['x-csrf-token'] === 'owner-csrf-proof'
        && req.headers.origin === 'https://tron-transfer.onrender.com'
      return valid ? { address: OWNER } : null
    },
  })
  const body = { confirm: 'INITIALIZE_SPONSOR_LEDGER_SCHEMA' }
  const denied = await call(api, 'POST', '/api/sponsor/ledger/bootstrap', body, null, '', {
    headers: { cookie: 'tron_owner_session=owner-session' },
  })
  assert.equal(denied.status, 401)
  assert.equal(schemaCreated, false)

  const accepted = await call(api, 'POST', '/api/sponsor/ledger/bootstrap', body, null, '', {
    headers: {
      cookie: 'tron_owner_session=owner-session',
      'x-csrf-token': 'owner-csrf-proof',
      origin: 'https://tron-transfer.onrender.com',
    },
  })
  assert.equal(accepted.status, 200)
  assert.equal(accepted.payload.sponsorWritesPaused, true)
  assert.equal(accepted.payload.transactionExecutionAvailable, false)
  assert.equal(schemaCreated, true)
})

test('Sponsor operation history reads never bootstrap or mutate the ledger schema', async () => {
  const queries = []
  const database = {
    async query(sql) {
      queries.push(sql)
      if (sql.includes('to_regclass')) {
        return { rowCount: 1, rows: [{ operations_table: 'tron_transfer_sponsor_operations', control_table: 'tron_transfer_sponsor_control', prepared_transaction_column: true, signed_transaction_column: true }] }
      }
      if (sql.includes('SELECT writes_paused')) return { rowCount: 1, rows: [{ writes_paused: true }] }
      if (sql.includes('SELECT operation,resource,amount_sun')) return { rowCount: 0, rows: [] }
      throw new Error('history reads must not create or alter Sponsor schema')
    },
  }
  const { api } = setup({ database, databaseUrl: 'postgres://configured' })
  const token = await authenticated(api)
  const result = await call(api, 'GET', '/api/sponsor/operations?limit=20', undefined, token)
  assert.equal(result.status, 200)
  assert.deepEqual(result.payload.operations, [])
  assert.equal(queries.some(sql => /^\\s*(CREATE|ALTER|DROP|INSERT|UPDATE)\\b/im.test(sql)), false)
})

test('Sponsor status fails closed when the ledger control row is missing', async () => {
  const database = {
    async query(sql) {
      if (sql.includes('to_regclass')) {
        return { rowCount: 1, rows: [{ operations_table: 'tron_transfer_sponsor_operations', control_table: 'tron_transfer_sponsor_control', prepared_transaction_column: true, signed_transaction_column: true }] }
      }
      if (sql.includes('SELECT writes_paused')) return { rowCount: 0, rows: [] }
      throw new Error('status endpoint must remain read-only')
    },
  }
  const engine = {
    readiness: () => ({ configured: true, enabled: true, broadcastAvailable: true, ownerAddress: OWNER, feePolicy: {} }),
    execute: async () => assert.fail('missing control row must never enable execution'),
    reconcile: async () => ({ confirmed: false, status: 'not-solidified' }),
  }
  const databaseUrl = 'postgres://test_user:test_password@ep-test.ap-southeast-1.aws.neon.tech/sponsor?sslmode=require'
  const expectedDatabaseIdentitySha256 = sponsorDatabaseConnectionInfo({ DATABASE_URL: databaseUrl }).identityFingerprint
  const { api } = setup({ database, databaseUrl, expectedDatabaseIdentitySha256, engine, authenticateOwnerAdminSession: null })
  const result = await call(api, 'GET', '/api/sponsor/status')
  assert.equal(result.status, 200)
  assert.equal(result.payload.databaseReady, false)
  assert.equal(result.payload.databaseStatus, 'control-row-missing')
  assert.equal(result.payload.sponsorWritesPaused, true)
  assert.equal(result.payload.transactionExecutionAvailable, false)
})

test('Sponsor status classifies database connection failures without exposing error details', async () => {
  const database = {
    async query() {
      throw Object.assign(new Error('connection to private-db-host.example failed'), { code: 'ECONNREFUSED' })
    },
  }
  const { api } = setup({ database, databaseUrl: 'postgres://configured' })
  const result = await call(api, 'GET', '/api/sponsor/status')
  assert.equal(result.status, 200)
  assert.equal(result.payload.databaseConfigured, true)
  assert.equal(result.payload.databaseReady, false)
  assert.equal(result.payload.databaseStatus, 'connection-refused')
  assert.equal(result.payload.sponsorWritesPaused, true)
  assert.equal(result.payload.transactionExecutionAvailable, false)
  assert.equal(JSON.stringify(result.payload).includes('private-db-host.example'), false)
})

test('Sponsor readiness distinguishes Sponsor execution from Owner-only ledger bootstrap', async () => {
  const database = {
    async query(sql) {
      if (sql.includes('to_regclass')) return { rowCount: 1, rows: [{ operations_table: 'tron_transfer_sponsor_operations', control_table: 'tron_transfer_sponsor_control', prepared_transaction_column: true, signed_transaction_column: true }] }
      if (sql.includes('SELECT writes_paused')) return { rowCount: 1, rows: [{ writes_paused: false }] }
      throw new Error('status endpoint must not mutate the Sponsor ledger schema')
    },
  }
  const engine = {
    readiness: () => ({ configured: true, enabled: true, broadcastAvailable: true, ownerAddress: OWNER, feePolicy: {} }),
    execute: async () => assert.fail('execution must remain disabled'),
    reconcile: async () => ({ confirmed: false, status: 'not-solidified' }),
  }
  const { api } = setup({ database, databaseUrl: 'postgres://configured', engine, ownerSessionFixture: 'too-short' })
  const result = await call(api, 'GET', '/api/sponsor/status')
  assert.equal(result.status, 200)
  assert.equal(result.payload.ownerAdminSessionRequired, false)
  assert.equal(result.payload.ownerAdminSessionConfiguredForLedgerBootstrap, true)
  assert.equal(result.payload.ownerAdminSessionConfigured, true)
  assert.equal(result.payload.databaseReady, true)
  assert.equal(result.payload.databaseStatus, 'ready')
  assert.equal(result.payload.transactionExecutionAvailable, false)
})

test('session challenge is bound to configured independent Sponsor wallet', async () => {
  const { api } = setup()
  const denied = await call(api, 'POST', '/api/sponsor/session/challenge', { address: OWNER })
  assert.equal(denied.status, 403)
  const accepted = await call(api, 'POST', '/api/sponsor/session/challenge', { address: SPONSOR })
  assert.equal(accepted.status, 201)
  assert.match(accepted.payload.message, /TRON Mainnet/)
  assert.match(accepted.payload.message, new RegExp(SPONSOR))
  assert.match(accepted.payload.message, /not a transaction/)
})

test('challenge can be verified once and creates a short-lived bearer session', async () => {
  const { api } = setup()
  const challenge = await call(api, 'POST', '/api/sponsor/session/challenge', { address: SPONSOR })
  const body = { address: SPONSOR, nonce: challenge.payload.nonce, signature: SIGNATURE }
  const first = await call(api, 'POST', '/api/sponsor/session/verify', body)
  assert.equal(first.status, 200)
  assert.match(first.payload.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  const replay = await call(api, 'POST', '/api/sponsor/session/verify', body)
  assert.equal(replay.status, 401)
})

test('managed Sponsor password sessions authorize through the backend cookie verifier and require CSRF on writes', async () => {
  const calls = []
  const { api } = setup({
    authenticateManagedSession: async (_req, options) => {
      calls.push(options)
      return null
    },
  })
  const deniedWrite = await call(api, 'POST', '/api/sponsor/intent', {
    operation: 'delegate', resource: 'ENERGY', amountSun: '1000000',
    idempotencyKey: 'managed-session-csrf-test-0001',
  }, null)
  assert.equal(deniedWrite.status, 401)
  assert.deepEqual(calls, [{ requireCsrf: true }])

  const deniedRead = await call(api, 'GET', '/api/sponsor/operations?limit=10')
  assert.equal(deniedRead.status, 401)
  assert.deepEqual(calls, [{ requireCsrf: true }, { requireCsrf: false }])
})

test('managed password session authorizes a short-lived exact intent without a browser message signature', async () => {
  const authCalls = []
  const { api } = setup({
    authenticateManagedSession: async (_req, options) => {
      authCalls.push(options)
      return { address: SPONSOR, sessionId: 'managed-sponsor-session' }
    },
  })
  const client = { headers: { origin: 'https://tron-transfer.onrender.com', 'x-csrf-token': 'csrf-proof' } }
  const intent = await call(api, 'POST', '/api/sponsor/intent', {
    operation: 'delegate', resource: 'ENERGY', amountSun: '1000000',
    idempotencyKey: 'managed-password-intent-test-0001',
  }, null, OWNER_SESSION_FIXTURE, client)
  assert.equal(intent.status, 201)
  assert.equal(authCalls[0].requireCsrf, true)

  const result = await call(api, 'POST', '/api/sponsor/operations', {
    intentId: intent.payload.intentId,
    confirmPhrase: intent.payload.confirmationPhrase,
  }, null, OWNER_SESSION_FIXTURE, client)
  assert.equal(result.status, 410)
  assert.equal(result.payload.error, 'legacy-sponsor-server-signer-route-disabled')
  assert.equal(authCalls.length, 2)
})

test('all private Sponsor operations require a valid bearer session', async () => {
  const { api } = setup()
  const result = await call(api, 'POST', '/api/sponsor/intent', {
    operation: 'delegate', resource: 'ENERGY', amountSun: '1000000', idempotencyKey: 'sponsor-op-0123456789012345',
  })
  assert.equal(result.status, 401)
})

test('transaction intent binds exact operation, resource, amount, wallets and idempotency key', async () => {
  const { api } = setup()
  const token = await authenticated(api)
  const result = await call(api, 'POST', '/api/sponsor/intent', {
    operation: 'delegate', resource: 'ENERGY', amountSun: '127852400', idempotencyKey: 'sponsor-op-0123456789012345',
  }, token)
  assert.equal(result.status, 201)
  assert.match(result.payload.message, /Operation: delegate/)
  assert.match(result.payload.message, /Resource: ENERGY/)
  assert.match(result.payload.message, /Amount \(sun\): 127852400/)
  assert.match(result.payload.message, new RegExp(OWNER))
  assert.equal(result.payload.confirmationPhrase, 'CONFIRM TRON MAINNET SPONSOR TRANSACTION')
})

test('legacy one-step endpoint rejects all Sponsor execution attempts after migration to two-phase local signing', async () => {
  const { api, calls } = setup()
  const token = await authenticated(api)
  const intent = await call(api, 'POST', '/api/sponsor/intent', {
    operation: 'delegate', resource: 'BANDWIDTH', amountSun: '1000000', idempotencyKey: 'sponsor-op-0123456789012345',
  }, token)
  const body = { intentId: intent.payload.intentId, signature: SIGNATURE, confirmPhrase: intent.payload.confirmationPhrase }
  const first = await call(api, 'POST', '/api/sponsor/operations', body, token)
  assert.equal(first.status, 410)
  assert.equal(first.payload.error, 'legacy-sponsor-server-signer-route-disabled')
  const replay = await call(api, 'POST', '/api/sponsor/operations', body, token)
  assert.equal(replay.status, 410)
  assert.deepEqual(calls, [])
})


test('Sponsor local transaction preparation refuses to run while the durable Mainnet write pause is active', async () => {
  const queries = []
  const database = {
    async query(sql) {
      queries.push(sql)
      if (sql.includes('to_regclass')) return { rowCount: 1, rows: [{ operations_table: 'tron_transfer_sponsor_operations', control_table: 'tron_transfer_sponsor_control', prepared_transaction_column: true, signed_transaction_column: true }] }
      if (sql.includes('SELECT writes_paused')) return { rowCount: 1, rows: [{ writes_paused: true }] }
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] }
      throw new Error('unexpected database query: ' + sql)
    },
    async connect() { return this },
    release() {},
  }
  let prepareCalls = 0
  const engine = {
    readiness: () => ({ configured: false, enabled: false, broadcastAvailable: false, clientSigningAvailable: true, ownerAddress: OWNER, sponsorAddress: SPONSOR, feePolicy: {} }),
    prepare: async () => { prepareCalls++; return { success: true, transaction: { txID: 'a'.repeat(64) } } },
    submitSigned: async () => { assert.fail('submit must not run while paused') },
    execute: async () => assert.fail('legacy engine must not run'),
    reconcile: async () => ({ confirmed: false, status: 'not-solidified' }),
  }
  const databaseUrl = 'postgres://test_user:test_password@ep-test.ap-southeast-1.aws.neon.tech/sponsor?sslmode=require'
  const expectedDatabaseIdentitySha256 = sponsorDatabaseConnectionInfo({ DATABASE_URL: databaseUrl }).identityFingerprint
  const { api } = setup({ database, engine, databaseUrl, expectedDatabaseIdentitySha256 })
  const token = await authenticated(api)
  const intent = await call(api, 'POST', '/api/sponsor/intent', {
    operation: 'delegate', resource: 'ENERGY', amountSun: '127852400',
    idempotencyKey: 'sponsor-paused-prepare-0123456789',
  }, token)
  assert.equal(intent.status, 201)
  const result = await call(api, 'POST', '/api/sponsor/operations/prepare', {
    intentId: intent.payload.intentId, confirmPhrase: 'CONFIRM TRON MAINNET SPONSOR TRANSACTION',
  }, token)
  assert.equal(result.status, 423)
  assert.equal(result.payload.error, 'sponsor-writes-paused-for-maintenance')
  assert.equal(prepareCalls, 0)
  assert.equal(queries.some(sql => sql.startsWith('INSERT INTO public.tron_transfer_sponsor_operations')), false)
})


test('Sponsor cancellation can only close an unsigned reserved operation', async () => {
  const queries = []
  const database = {
    async query(sql) {
      queries.push(sql)
      if (sql.includes('to_regclass')) return { rowCount: 1, rows: [{ operations_table: 'tron_transfer_sponsor_operations', control_table: 'tron_transfer_sponsor_control', prepared_transaction_column: true, signed_transaction_column: true }] }
      if (sql.includes('SELECT writes_paused')) return { rowCount: 1, rows: [{ writes_paused: true }] }
      if (sql.startsWith("UPDATE public.tron_transfer_sponsor_operations SET status='failed'")) return { rowCount: 1, rows: [{ id: 1 }] }
      throw new Error('unexpected database query: ' + sql)
    },
  }
  const databaseUrl = 'postgres://test_user:test_password@ep-test.ap-southeast-1.aws.neon.tech/sponsor?sslmode=require'
  const expectedDatabaseIdentitySha256 = sponsorDatabaseConnectionInfo({ DATABASE_URL: databaseUrl }).identityFingerprint
  const { api } = setup({ database, databaseUrl, expectedDatabaseIdentitySha256 })
  const token = await authenticated(api)
  const result = await call(api, 'POST', '/api/sponsor/operations/cancel', {
    operationReference: 'sponsor-cancel-reservation-0123456789',
  }, token)
  assert.equal(result.status, 200)
  assert.equal(result.payload.operationStatus, 'failed')
  assert.equal(result.payload.resultCode, 'cancelled-before-signing')
  assert.ok(queries.some(sql => sql.includes("signed_transaction IS NULL")))
})

test('legacy one-step Sponsor execution endpoint is disabled in favor of local prepare and submit', async () => {
  const queries = []
  const database = {
    async query(sql) {
      queries.push(sql)
      if (sql.includes('to_regclass')) return { rowCount: 1, rows: [{ operations_table: 'tron_transfer_sponsor_operations', control_table: 'tron_transfer_sponsor_control', prepared_transaction_column: true, signed_transaction_column: true }] }
      if (sql.includes('SELECT writes_paused')) return { rowCount: 1, rows: [{ writes_paused: false }] }
      if (sql === 'ROLLBACK' || sql === 'BEGIN') return { rowCount: 0, rows: [] }
      throw new Error('unexpected database query: ' + sql)
    },
    async connect() { return this },
    release() {},
  }
  let executions = 0
  const engine = {
    readiness: () => ({ configured: true, enabled: true, broadcastAvailable: true, ownerAddress: OWNER, sponsorAddress: SPONSOR, feePolicy: {} }),
    execute: async () => { executions += 1; return { success: true } },
    reconcile: async () => ({ confirmed: false, status: 'not-solidified' }),
  }
  const { api } = setup({ database, engine })
  const token = await authenticated(api)
  const intent = await call(api, 'POST', '/api/sponsor/intent', {
    operation: 'delegate', resource: 'ENERGY', amountSun: '127852400',
    idempotencyKey: 'sponsor-idempotency-012345678901',
  }, token)
  assert.equal(intent.status, 201)
  const result = await call(api, 'POST', '/api/sponsor/operations', {
    intentId: intent.payload.intentId, signature: SIGNATURE,
    confirmPhrase: 'CONFIRM TRON MAINNET SPONSOR TRANSACTION',
  }, token)
  assert.equal(result.status, 410)
  assert.equal(result.payload.error, 'legacy-sponsor-server-signer-route-disabled')
  assert.equal(executions, 0)
  assert.equal(queries.some(sql => sql.startsWith('INSERT INTO public.tron_transfer_sponsor_operations')), false)
})


test('Owner TRX top-up intent is bound to the configured Owner and TRX resource', async () => {
  const { api } = setup()
  const token = await authenticated(api)
  const result = await call(api, 'POST', '/api/sponsor/intent', {
    operation: 'topup', resource: 'TRX', amountSun: '2500000',
    idempotencyKey: 'sponsor-topup-0123456789012345',
  }, token)
  assert.equal(result.status, 201)
  assert.match(result.payload.message, /Operation: topup/)
  assert.match(result.payload.message, /Resource: TRX/)
  assert.match(result.payload.message, /Amount \(sun\): 2500000/)
  assert.match(result.payload.message, new RegExp(OWNER))
})

test('invalid resource combinations cannot create Sponsor intents', async () => {
  const { api } = setup()
  const token = await authenticated(api)
  const result = await call(api, 'POST', '/api/sponsor/intent', {
    operation: 'topup', resource: 'ENERGY', amountSun: '1000000',
    idempotencyKey: 'sponsor-invalid-topup-0123456789',
  }, token)
  assert.equal(result.status, 400)
  assert.equal(result.payload.error, 'invalid-sponsor-operation-intent')
})


test('independent Sponsor session authorizes its own operation intent without an Owner session', async () => {
  const { api } = setup({ ownerSessionFixture: '', authenticateOwnerAdminSession: null })
  const token = await authenticated(api)
  const body = {
    operation: 'topup', resource: 'TRX', amountSun: '1000000',
    idempotencyKey: 'sponsor-independent-topup-0123456789',
  }
  const sponsorAuthorized = await call(api, 'POST', '/api/sponsor/intent', body, token, null, {
    headers: { 'x-sponsor-admin-token': OWNER_SESSION_FIXTURE },
  })
  assert.equal(sponsorAuthorized.status, 201)
  assert.equal(sponsorAuthorized.payload.success, true)
})


test('Sponsor transaction preparation fails closed until ledger durability, backup and restore are verified', async () => {
  const databaseUrl = 'postgres://test_user:test_password@ep-test.ap-southeast-1.aws.neon.tech/sponsor?sslmode=require'
  const expectedDatabaseIdentitySha256 = sponsorDatabaseConnectionInfo({ DATABASE_URL: databaseUrl }).identityFingerprint
  const { api, env, advanceClock } = setup({ databaseUrl, expectedDatabaseIdentitySha256 })
  const token = await authenticated(api)
  const status = await call(api, 'GET', '/api/sponsor/status')
  assert.equal(status.payload.ledgerDurabilityVerified, true)

  const intent = await call(api, 'POST', '/api/sponsor/intent', {
    operation: 'delegate', resource: 'ENERGY', amountSun: '1000000',
    idempotencyKey: 'sponsor-unverified-ledger-0123456789',
  }, token)
  assert.equal(intent.status, 201)

  env.SPONSOR_LEDGER_DURABLE = 'false'
  advanceClock(5_001)
  const unverifiedStatus = await call(api, 'GET', '/api/sponsor/status')
  assert.equal(unverifiedStatus.payload.ledgerDurabilityVerified, false)
  assert.equal(unverifiedStatus.payload.transactionExecutionAvailable, false)

  const prepared = await call(api, 'POST', '/api/sponsor/operations/prepare', {
    intentId: intent.payload.intentId,
    confirmPhrase: intent.payload.confirmationPhrase,
  }, token)
  assert.equal(prepared.status, 503)
  assert.equal(prepared.payload.error, 'sponsor-ledger-durability-not-verified')
})

test('Sponsor transaction readiness does not depend on Owner Admin session availability', async () => {
  const { api } = setup({ ownerSessionFixture: '', authenticateOwnerAdminSession: null })
  const status = await call(api, 'GET', '/api/sponsor/status')
  assert.equal(status.payload.ownerAdminSessionRequired, false)
  assert.equal(status.payload.ownerAdminSessionConfiguredForLedgerBootstrap, false)
  const token = await authenticated(api)
  const result = await call(api, 'POST', '/api/sponsor/intent', {
    operation: 'delegate', resource: 'ENERGY', amountSun: '1000000',
    idempotencyKey: 'sponsor-no-owner-session-012345',
  }, token, null)
  assert.equal(result.status, 201)
})




test('Stake 2.0 reclaim and withdrawal intents are accepted with exact resource bindings', async () => {
  const { api } = setup()
  const token = await authenticated(api)
  const cases = [
    ['undelegate', 'ENERGY'],
    ['unstake', 'BANDWIDTH'],
    ['withdraw', 'TRX'],
  ]
  for (const [operation, resource] of cases) {
    const result = await call(api, 'POST', '/api/sponsor/intent', {
      operation, resource, amountSun: '1000000',
      idempotencyKey: 'sponsor-' + operation + '-0123456789',
    }, token)
    assert.equal(result.status, 201, operation + ' intent should be accepted')
    assert.match(result.payload.message, new RegExp('Operation: ' + operation))
    assert.match(result.payload.message, new RegExp('Resource: ' + resource))
  }
})

test('Stake 2.0 reclaim intents reject invalid resource combinations', async () => {
  const { api } = setup()
  const token = await authenticated(api)
  const result = await call(api, 'POST', '/api/sponsor/intent', {
    operation: 'undelegate', resource: 'TRX', amountSun: '1000000',
    idempotencyKey: 'sponsor-undelegate-invalid-012345',
  }, token)
  assert.equal(result.status, 400)
  assert.equal(result.payload.error, 'invalid-sponsor-operation-intent')
})

test('Sponsor Resource API prefers the Neon pooled URL and retains direct URL as fallback', () => {
  const direct = 'postgresql://direct-user:direct-secret@direct.example.test/db?sslmode=require'
  const pooled = 'postgresql://pooled-user:pooled-secret@pooler.example.test/db?sslmode=require'
  assert.equal(sponsorDatabaseConnectionString({ DATABASE_URL: direct, DATABASE_URL_POOLED: pooled }), pooled)
  assert.equal(sponsorDatabaseConnectionString({ DATABASE_URL: direct }), direct)
  assert.equal(sponsorDatabaseConnectionString({}), null)
})


test('signed-not-broadcast operation recovers after API restart against solidified Mainnet state without replay', async () => {
  const key = 'sponsor-signed-recovery-0123456789'
  const keyHash = (await import('node:crypto')).createHash('sha256').update(key).digest('hex')
  const row = {
    idempotency_key_hash: keyHash, operation: 'delegate', resource: 'ENERGY', amount_sun: '1000000',
    sponsor_address: SPONSOR, owner_address: OWNER, status: 'signed-not-broadcast',
    transaction_id: 'c'.repeat(64), result_code: 'broadcast-not-attempted', confirmation_block: null,
  }
  const updates = []
  const database = {
    async query(sql, params = []) {
      if (sql.includes('to_regclass')) return { rowCount: 1, rows: [{ operations_table: 'tron_transfer_sponsor_operations', control_table: 'tron_transfer_sponsor_control', prepared_transaction_column: true, signed_transaction_column: true }] }
      if (sql.includes('SELECT writes_paused')) return { rowCount: 1, rows: [{ writes_paused: true }] }
      if (sql.includes('SELECT idempotency_key_hash,operation,resource,amount_sun::text')) return { rowCount: 1, rows: [row] }
      if (sql.includes('SET status=$2,result_code=$3,confirmation_block=$4')) {
        updates.push(params)
        row.status = params[1]; row.result_code = params[2]; row.confirmation_block = params[3]
        return { rowCount: 1, rows: [] }
      }
      throw new Error('unexpected recovery query: ' + sql)
    },
  }
  let reconciliations = 0
  const engine = {
    readiness: () => ({ configured: true, enabled: true, broadcastAvailable: true, ownerAddress: OWNER, sponsorAddress: SPONSOR, feePolicy: {} }),
    execute: async () => assert.fail('recovery must never execute, sign, or broadcast'),
    reconcile: async input => {
      reconciliations += 1
      assert.equal(input.transactionId, 'c'.repeat(64))
      assert.equal(input.operation, 'delegate')
      return { confirmed: true, status: 'solidified-success', blockNumber: 987654 }
    },
  }
  const databaseUrl = 'postgres://test_user:test_password@ep-test.ap-southeast-1.aws.neon.tech/sponsor?sslmode=require'
  const expectedDatabaseIdentitySha256 = sponsorDatabaseConnectionInfo({ DATABASE_URL: databaseUrl }).identityFingerprint
  const firstProcess = setup({ database, databaseUrl, expectedDatabaseIdentitySha256, engine })
  const token = await authenticated(firstProcess.api)
  // Simulate a Render process restart: create a fresh API instance with empty
  // in-memory challenge/intent maps while retaining only the durable DB row
  // and the same session-signing secret.
  const restartedProcess = setup({ database, databaseUrl, expectedDatabaseIdentitySha256, engine })
  const result = await call(restartedProcess.api, 'GET', '/api/sponsor/operations/' + key, undefined, token)
  assert.equal(result.status, 200)
  assert.equal(result.payload.success, true)
  assert.equal(result.payload.operation.status, 'confirmed')
  assert.deepEqual(result.payload.reconciliation, { attempted: true, confirmed: true, status: 'solidified-success', blockNumber: 987654 })
  assert.equal(reconciliations, 1)
  assert.equal(updates.length, 1)
})

test('ambiguous Sponsor operation remains non-retryable when Mainnet reconciliation is inconclusive', async () => {
  const key = 'sponsor-ambiguous-recovery-012345'
  const keyHash = (await import('node:crypto')).createHash('sha256').update(key).digest('hex')
  const row = {
    idempotency_key_hash: keyHash, operation: 'topup', resource: 'TRX', amount_sun: '1000000',
    sponsor_address: SPONSOR, owner_address: OWNER, status: 'broadcast-unknown',
    transaction_id: 'd'.repeat(64), result_code: 'broadcast-outcome-unknown', confirmation_block: null,
  }
  const updates = []
  const database = {
    async query(sql, params = []) {
      if (sql.includes('to_regclass')) return { rowCount: 1, rows: [{ operations_table: 'tron_transfer_sponsor_operations', control_table: 'tron_transfer_sponsor_control', prepared_transaction_column: true, signed_transaction_column: true }] }
      if (sql.includes('SELECT writes_paused')) return { rowCount: 1, rows: [{ writes_paused: true }] }
      if (sql.includes('SELECT idempotency_key_hash,operation,resource,amount_sun::text')) return { rowCount: 1, rows: [row] }
      if (sql.includes('SET result_code=$2,updated_at=now()')) {
        updates.push(params); row.result_code = params[1]
        return { rowCount: 1, rows: [] }
      }
      throw new Error('unexpected recovery query: ' + sql)
    },
  }
  let executions = 0
  const engine = {
    readiness: () => ({ configured: true, enabled: true, broadcastAvailable: true, ownerAddress: OWNER, sponsorAddress: SPONSOR, feePolicy: {} }),
    execute: async () => { executions += 1; return assert.fail('ambiguous operation must never be replayed') },
    reconcile: async () => ({ confirmed: false, status: 'solidified-provider-unavailable' }),
  }
  const databaseUrl = 'postgres://test_user:test_password@ep-test.ap-southeast-1.aws.neon.tech/sponsor?sslmode=require'
  const expectedDatabaseIdentitySha256 = sponsorDatabaseConnectionInfo({ DATABASE_URL: databaseUrl }).identityFingerprint
  const { api } = setup({ database, databaseUrl, expectedDatabaseIdentitySha256, engine })
  const token = await authenticated(api)
  const result = await call(api, 'GET', '/api/sponsor/operations/' + key, undefined, token)
  assert.equal(result.status, 200)
  assert.equal(result.payload.success, false)
  assert.equal(result.payload.operation.status, 'broadcast-unknown')
  assert.equal(result.payload.reconciliation.confirmed, false)
  assert.equal(result.payload.retryAllowed, false)
  assert.equal(executions, 0)
  assert.equal(updates.length, 1)
})


test('legacy Sponsor server-signed execution endpoint is permanently disabled', async () => {
  const timeline = []
  const database = {
    async query(sql) {
      if (sql.includes('to_regclass')) return { rowCount: 1, rows: [{ operations_table: 'tron_transfer_sponsor_operations', control_table: 'tron_transfer_sponsor_control', prepared_transaction_column: true, signed_transaction_column: true }] }
      if (sql.includes('SELECT writes_paused')) return { rowCount: 1, rows: [{ writes_paused: false }] }
      throw new Error('unexpected database query: ' + sql)
    },
    async connect() {
      return {
        async query(sql) {
          timeline.push(sql)
          if (sql === 'BEGIN') return { rowCount: 0, rows: [] }
          if (sql.includes('FOR SHARE')) return { rowCount: 1, rows: [{ writes_paused: false }] }
          if (sql === 'ROLLBACK') return { rowCount: 0, rows: [] }
          throw new Error('unexpected transaction query: ' + sql)
        },
        release() { timeline.push('release') },
      }
    },
  }
  let executions = 0
  const engine = {
    readiness: () => ({ configured: true, enabled: true, broadcastAvailable: true, ownerAddress: OWNER, sponsorAddress: SPONSOR, feePolicy: {} }),
    execute: async () => { executions += 1; return { success: true } },
    reconcile: async () => ({ confirmed: false, status: 'not-solidified' }),
  }
  const databaseUrl = 'postgres://test_user:test_password@ep-test.ap-southeast-1.aws.neon.tech/sponsor?sslmode=require'
  const expectedDatabaseIdentitySha256 = sponsorDatabaseConnectionInfo({ DATABASE_URL: databaseUrl }).identityFingerprint
  const { api } = setup({ database, databaseUrl, expectedDatabaseIdentitySha256, engine })
  const token = await authenticated(api)
  const intent = await call(api, 'POST', '/api/sponsor/intent', {
    operation: 'delegate', resource: 'ENERGY', amountSun: '1000000',
    idempotencyKey: 'sponsor-lock-lifecycle-0123456789',
  }, token)
  const result = await call(api, 'POST', '/api/sponsor/operations', {
    intentId: intent.payload.intentId, signature: SIGNATURE,
    confirmPhrase: 'CONFIRM TRON MAINNET SPONSOR TRANSACTION',
  }, token)
  assert.equal(result.status, 410)
  assert.equal(result.payload.error, 'legacy-sponsor-server-signer-route-disabled')
  assert.equal(executions, 0)
  assert.equal(timeline.length, 0)
})


test('PostgreSQL legacy require mode is normalized to explicit verify-full without weakening TLS', () => {
  const input = 'postgresql://user:password@ep-example.neon.tech/db?sslmode=require&channel_binding=require'
  const normalized = new URL(normalizePostgresTlsMode(input))
  assert.equal(normalized.searchParams.get('sslmode'), 'verify-full')
  assert.equal(normalized.searchParams.get('channel_binding'), 'require')
  assert.equal(normalized.hostname, 'ep-example.neon.tech')
})

test('PostgreSQL explicit verify-full and local disable modes are preserved', () => {
  const strict = 'postgres://user:password@db.example.test/app?sslmode=verify-full'
  const local = 'postgres://user:password@localhost/app?sslmode=disable'
  assert.equal(normalizePostgresTlsMode(strict), new URL(strict).toString())
  assert.equal(normalizePostgresTlsMode(local), new URL(local).toString())
})

test('Sponsor readiness coalesces simultaneous status refreshes into one database snapshot', async () => {
  let queryCount = 0
  const database = {
    async query(sql) {
      queryCount += 1
      await new Promise(resolve => setTimeout(resolve, 20))
      if (sql.includes('to_regclass')) {
        return { rowCount: 1, rows: [{ operations_table: 'tron_transfer_sponsor_operations', control_table: 'tron_transfer_sponsor_control', prepared_transaction_column: true, signed_transaction_column: true }] }
      }
      if (sql.includes('SELECT writes_paused')) return { rowCount: 1, rows: [{ writes_paused: true }] }
      throw new Error('unexpected Sponsor status query')
    },
  }
  const { api } = setup({ database, databaseUrl: 'postgres://configured' })
  const [first, second] = await Promise.all([
    call(api, 'GET', '/api/sponsor/status'),
    call(api, 'GET', '/api/sponsor/status'),
  ])
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(first.payload.sponsorWritesPaused, true)
  assert.equal(first.payload.writesReleaseAvailable, false)
  assert.ok(first.payload.writesReleaseChecks.some(check => check.id === 'explicit-release-flag' && check.state === 'blocked'))
  assert.equal(second.payload.sponsorWritesPaused, true)
  assert.equal(queryCount, 3)
  const cached = await call(api, 'GET', '/api/sponsor/status')
  assert.equal(cached.status, 200)
  assert.equal(queryCount, 3)
})

test('Sponsor intents are authorized by the Sponsor session, not the Owner Admin session', async () => {
  const { api } = setup({
    authenticateOwnerAdminSession: async req => String(req.headers.cookie || '').includes('owner-admin-session') ? { address: OWNER } : null,
  })
  const token = await authenticated(api)
  const intent = { operation: 'delegate', resource: 'ENERGY', amountSun: '1000000', idempotencyKey: 'sponsor-session-intent-0001' }
  const sponsorAuthorized = await call(api, 'POST', '/api/sponsor/intent', intent, token)
  assert.equal(sponsorAuthorized.status, 201)
  assert.equal(sponsorAuthorized.payload.success, true)
})

test('database target identity uses the direct Owner Admin URL while Sponsor runtime may use the pooler', () => {
  const direct = 'postgres://app_role@ep-main.ap-southeast-1.aws.neon.tech/tron-transfer?sslmode=require'
  const pooled = 'postgres://app_role@ep-main-pooler.ap-southeast-1.aws.neon.tech/tron-transfer?sslmode=require'
  const runtime = sponsorDatabaseConnectionInfo({ DATABASE_URL_POOLED: pooled, OWNER_ADMIN_DATABASE_URL: direct })
  const target = sponsorDatabaseTargetIdentityInfo({ DATABASE_URL_POOLED: pooled, OWNER_ADMIN_DATABASE_URL: direct })
  const directOnly = sponsorDatabaseTargetIdentityInfo({ DATABASE_URL: direct })
  assert.equal(runtime.sourceVariable, 'DATABASE_URL_POOLED')
  assert.equal(target.sourceVariable, 'OWNER_ADMIN_DATABASE_URL')
  assert.equal(target.identityFingerprint, directOnly.identityFingerprint)
  assert.equal(runtime.identityFingerprint, target.identityFingerprint, 'Neon pooler and direct endpoints for the same branch/database/role must normalize to one identity')

  const otherBranch = sponsorDatabaseConnectionInfo({ DATABASE_URL_POOLED: 'postgres://app_role@ep-other-pooler.ap-southeast-1.aws.neon.tech/tron-transfer?sslmode=require' })
  assert.notEqual(otherBranch.identityFingerprint, target.identityFingerprint, 'a different Neon branch must remain a different database identity')
})

test('managed Sponsor session cannot invoke the legacy server signer endpoint', async () => {
  let engineCalls = 0
  let rollbackCalls = 0
  const database = {
    async query(sql) {
      if (sql.includes('to_regclass')) {
        return { rowCount: 1, rows: [{ operations_table: 'tron_transfer_sponsor_operations', control_table: 'tron_transfer_sponsor_control', prepared_transaction_column: true, signed_transaction_column: true }] }
      }
      if (sql.includes('SELECT writes_paused')) return { rowCount: 1, rows: [{ writes_paused: false }] }
      if (sql === 'BEGIN') return { rowCount: 0, rows: [] }
      if (sql === 'ROLLBACK') { rollbackCalls += 1; return { rowCount: 0, rows: [] } }
      throw new Error('unexpected database query in fail-closed test: ' + sql)
    },
  }
  const engine = {
    readiness: () => ({ configured: true, enabled: true, broadcastAvailable: true, ownerAddress: OWNER, feePolicy: {} }),
    execute: async () => { engineCalls += 1; return { success: true, signed: true, broadcast: true } },
    reconcile: async () => ({ confirmed: false, status: 'not-solidified' }),
  }
  const databaseUrl = 'postgres://test_user:test_password@ep-test.ap-southeast-1.aws.neon.tech/sponsor?sslmode=require'
  const expectedDatabaseIdentitySha256 = sponsorDatabaseConnectionInfo({ DATABASE_URL: databaseUrl }).identityFingerprint
  const { api } = setup({ database, databaseUrl, expectedDatabaseIdentitySha256, engine })
  const token = await authenticated(api)
  const intent = await call(api, 'POST', '/api/sponsor/intent', {
    operation: 'delegate', resource: 'ENERGY', amountSun: '1000000',
    idempotencyKey: 'sponsor-local-signing-blocked-0001',
  }, token)
  assert.equal(intent.status, 201)

  const result = await call(api, 'POST', '/api/sponsor/operations', {
    intentId: intent.payload.intentId,
    confirmPhrase: intent.payload.confirmationPhrase,
  }, token)
  assert.equal(result.status, 410)
  assert.equal(result.payload.error, 'legacy-sponsor-server-signer-route-disabled')
  assert.equal(engineCalls, 0, 'the legacy server-side signer must never be invoked')
  assert.equal(rollbackCalls, 0, 'the disabled route must not open a database transaction')
})

test('managed Sponsor session is rejected if its enrolled address no longer matches the configured Mainnet Sponsor', async () => {
  const { api, env } = setup({
    authenticateManagedSession: async () => ({ address: SPONSOR, sessionId: 'managed-sponsor-session' }),
  })
  env.SPONSOR_MAINNET_ADDRESS = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'
  const result = await call(api, 'POST', '/api/sponsor/intent', {
    operation: 'delegate', resource: 'ENERGY', amountSun: '1000000',
    idempotencyKey: 'sponsor-session-address-rotation-0001',
  }, 'managed-sponsor-session-token')
  assert.equal(result.status, 403)
  assert.equal(result.payload.error, 'sponsor-session-address-mismatch')
})

test('Sponsor local-signing API commits the signed transaction before a single broadcast attempt', async () => {
  const timeline = []
  let persistedTransactionId = null
  let persistedSignedPayload = null
  const operationReference = 'sponsor-two-phase-lifecycle-0123456789'
  const transaction = {
    txID: 'a'.repeat(64),
    raw_data_hex: '01'.repeat(20),
    raw_data: { expiration: Date.now() + 60_000, contract: [{ type: 'FreezeBalanceV2Contract', parameter: { value: { owner_address: '41' + '11'.repeat(20), resource: 1, frozen_balance: '1000000' } } }] },
  }
  const database = {
    async query(sql) {
      if (sql.includes('to_regclass')) return { rowCount: 1, rows: [{ operations_table: 'tron_transfer_sponsor_operations', control_table: 'tron_transfer_sponsor_control', prepared_transaction_column: true, signed_transaction_column: true }] }
      if (sql.includes('SELECT writes_paused')) return { rowCount: 1, rows: [{ writes_paused: false }] }
      throw new Error('unexpected pool query: ' + sql)
    },
    async connect() {
      let transactionState = 'initial'
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN') { timeline.push('begin'); return { rowCount: 0, rows: [] } }
          if (sql === 'COMMIT') { timeline.push(transactionState === 'signed' ? 'commit-signed' : 'commit-final'); return { rowCount: 0, rows: [] } }
          if (sql === 'ROLLBACK') { timeline.push('rollback'); return { rowCount: 0, rows: [] } }
          if (sql.includes('SELECT writes_paused') && sql.includes('FOR SHARE')) return { rowCount: 1, rows: [{ writes_paused: false }] }
          if (sql.includes('INSERT INTO public.tron_transfer_sponsor_operations')) return { rowCount: 1, rows: [{ id: 1 }] }
          if (sql.includes('SET prepared_transaction=')) { transactionState = 'prepared'; timeline.push('persist-prepared'); return { rowCount: 1, rows: [{ id: 1 }] } }
          if (sql.includes('SELECT operation,resource,amount_sun')) return { rowCount: 1, rows: [{
            operation: 'stake', resource: 'ENERGY', amount_sun: '1000000', sponsor_address: SPONSOR,
            owner_address: OWNER, status: 'reserved', prepared_transaction: transaction,
          }] }
          if (sql.includes('SET status=\'signed-not-broadcast\'')) { persistedTransactionId = params[1]; persistedSignedPayload = JSON.parse(params[2]); transactionState = 'signed'; timeline.push('persist-signed'); return { rowCount: 1, rows: [{ id: 1 }] } }
          if (sql.includes('SELECT status,transaction_id')) return { rowCount: 1, rows: [{ status: 'signed-not-broadcast', transaction_id: transaction.txID }] }
          if (sql.includes('SET status=$2,result_code=$3')) { timeline.push('persist-final'); return { rowCount: 1, rows: [{ id: 1 }] } }
          throw new Error('unexpected client query: ' + sql)
        },
        release() { timeline.push('release') },
      }
    },
  }
  const engine = {
    readiness: () => ({ configured: false, enabled: false, broadcastAvailable: false, clientSigningAvailable: true, ownerAddress: OWNER, sponsorAddress: SPONSOR, feePolicy: {} }),
    prepare: async () => ({ success: true, transaction, sponsorAddress: SPONSOR, ownerAddress: OWNER, operation: 'stake', resource: 'ENERGY', amountSun: '1000000', feePolicy: { reserveSun: '2000000', maxBandwidthFeeSun: '0', requiredBandwidthFeeSun: '0' } }),
    submitSigned: async ({ onSigned }) => {
      await onSigned(transaction.txID)
      assert.ok(timeline.indexOf('commit-signed') >= 0, 'signed payload must be committed before broadcast')
      timeline.push('broadcast')
      return { success: true, status: 'solidified-success', txid: transaction.txID, signed: true, broadcast: true, solidified: true, blockNumber: 456 }
    },
    execute: async () => assert.fail('legacy server signer must never run'),
    reconcile: async () => ({ confirmed: false, status: 'not-solidified' }),
  }
  const databaseUrl = 'postgres://test_user:test_password@ep-test.ap-southeast-1.aws.neon.tech/sponsor?sslmode=require'
  const expectedDatabaseIdentitySha256 = sponsorDatabaseConnectionInfo({ DATABASE_URL: databaseUrl }).identityFingerprint
  const { api } = setup({ database, databaseUrl, expectedDatabaseIdentitySha256, engine })
  const token = await authenticated(api)
  const intent = await call(api, 'POST', '/api/sponsor/intent', {
    operation: 'stake', resource: 'ENERGY', amountSun: '1000000', idempotencyKey: operationReference,
  }, token)
  assert.equal(intent.status, 201)
  const prepared = await call(api, 'POST', '/api/sponsor/operations/prepare', {
    intentId: intent.payload.intentId, confirmPhrase: intent.payload.confirmationPhrase,
  }, token)
  assert.equal(prepared.status, 201, JSON.stringify({ intent: intent.payload, prepared: prepared.payload }))
  assert.equal(prepared.payload.unsignedTransaction.txID, transaction.txID)
  const signedTransaction = { ...transaction, signature: ['b'.repeat(130)] }
  const submitted = await call(api, 'POST', '/api/sponsor/operations/submit', {
    operationReference, signedTransaction,
  }, token)
  assert.equal(submitted.status, 200)
  assert.equal(submitted.payload.solidified, true)
  assert.equal(persistedTransactionId, transaction.txID, 'the exact prepared txID must be durable before broadcast')
  assert.deepEqual(persistedSignedPayload, signedTransaction, 'the complete signed payload, not only txID, must be durable before broadcast')
  assert.ok(timeline.indexOf('persist-signed') < timeline.indexOf('commit-signed'))
  assert.ok(timeline.indexOf('commit-signed') < timeline.indexOf('broadcast'))
  assert.ok(timeline.indexOf('broadcast') < timeline.indexOf('persist-final'))
})

test('Sponsor ledger bootstrap refuses a mismatched database identity before issuing any DDL', async () => {
  const queries = []
  const database = {
    async query(sql) {
      queries.push(sql)
      throw new Error('database must not be touched when the target identity is not accepted')
    },
  }
  const databaseUrl = 'postgres://test_user:test_password@ep-production.ap-southeast-1.aws.neon.tech/sponsor?sslmode=require'
  const { api } = setup({
    database,
    databaseUrl,
    expectedDatabaseIdentitySha256: 'f'.repeat(64),
  })
  const result = await call(api, 'POST', '/api/sponsor/ledger/bootstrap', {
    confirm: 'INITIALIZE_SPONSOR_LEDGER_SCHEMA',
  }, null, OWNER_SESSION_FIXTURE)
  assert.equal(result.status, 503)
  assert.equal(result.payload.error, 'sponsor-ledger-database-identity-not-accepted')
  assert.deepEqual(queries, [])
})

function sponsorControlDatabase(initialPaused, sponsorEnrolled = true) {
  let writesPaused = initialPaused
  let updateCount = 0
  let connectCount = 0
  const database = {
    async query(sql) {
      if (sql.includes('to_regclass')) return { rowCount: 1, rows: [{
        operations_table: 'tron_transfer_sponsor_operations',
        control_table: 'tron_transfer_sponsor_control',
        prepared_transaction_column: true,
        signed_transaction_column: true,
      }] }
      if (sql.includes('SELECT writes_paused')) return { rowCount: 1, rows: [{ writes_paused: writesPaused }] }
      if (sql.includes('SELECT wallet_role, wallet_address, enabled')) return { rowCount: 2, rows: [{ wallet_role: 'owner', wallet_address: OWNER, enabled: true }, { wallet_role: 'sponsor', wallet_address: sponsorEnrolled ? SPONSOR : OWNER, enabled: sponsorEnrolled }] }
      throw new Error('unexpected Sponsor control pool query: ' + sql)
    },
    async connect() {
      connectCount += 1
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] }
          if (sql.includes('FOR UPDATE')) return { rowCount: 1, rows: [{ writes_paused: writesPaused }] }
          if (sql.includes('UPDATE public.tron_transfer_sponsor_control')) {
            writesPaused = params[0]
            updateCount += 1
            return { rowCount: 1, rows: [{ writes_paused: writesPaused }] }
          }
          throw new Error('unexpected Sponsor control transaction query: ' + sql)
        },
        release() {},
      }
    },
  }
  return { database, state: () => ({ writesPaused, updateCount, connectCount }) }
}
function releaseReadySponsorEngine() {
  return {
    readiness: () => ({
      configured: true, enabled: true, broadcastAvailable: true, clientSigningAvailable: true,
      ownerAddress: OWNER, sponsorAddress: SPONSOR, sponsorAddressValid: true, feePolicy: {},
      stakingPolicy: { enabled: true }, ownerTopupPolicy: { enabled: true },
    }),
    prepare: async () => ({ success: true }),
    submitSigned: async () => ({ success: true }),
    execute: async () => assert.fail('release control must not execute Sponsor transactions'),
    reconcile: async () => ({ confirmed: false, status: 'not-solidified' }),
  }
}

test('Sponsor ledger release requires Owner Admin, explicit release flag and every Mainnet gate', async () => {
  const databaseUrl = 'postgres://test_user:test_password@ep-test.ap-southeast-1.aws.neon.tech/sponsor?sslmode=require'
  const expectedDatabaseIdentitySha256 = sponsorDatabaseConnectionInfo({ DATABASE_URL: databaseUrl }).identityFingerprint
  const blockedDb = sponsorControlDatabase(true)
  const blocked = setup({ database: blockedDb.database, databaseUrl, expectedDatabaseIdentitySha256, engine: releaseReadySponsorEngine() })
  const blockedResult = await call(blocked.api, 'POST', '/api/sponsor/ledger/release', {
    confirm: 'ENABLE_SPONSOR_MAINNET_WRITES',
  })
  assert.equal(blockedResult.status, 423)
  assert.equal(blockedResult.payload.error, 'sponsor-writes-release-gates-blocked')
  assert.equal(blockedDb.state().updateCount, 0)
  assert.ok(blockedResult.payload.writesReleaseChecks.some(check => check.id === 'explicit-release-flag' && check.state === 'blocked'))

  const unenrolledDb = sponsorControlDatabase(true, false)
  const unenrolled = setup({ database: unenrolledDb.database, databaseUrl, expectedDatabaseIdentitySha256, engine: releaseReadySponsorEngine() })
  unenrolled.env.SPONSOR_WRITES_RELEASE_ENABLED = 'true'
  const unenrolledResult = await call(unenrolled.api, 'POST', '/api/sponsor/ledger/release', {
    confirm: 'ENABLE_SPONSOR_MAINNET_WRITES',
  })
  assert.equal(unenrolledResult.status, 423)
  assert.ok(unenrolledResult.payload.writesReleaseChecks.some(check => check.id === 'sponsor-wallet-enrolled' && check.state === 'blocked'))
  assert.equal(unenrolledDb.state().updateCount, 0)

  const db = sponsorControlDatabase(true)
  const ready = setup({ database: db.database, databaseUrl, expectedDatabaseIdentitySha256, engine: releaseReadySponsorEngine() })
  ready.env.SPONSOR_WRITES_RELEASE_ENABLED = 'true'
  const result = await call(ready.api, 'POST', '/api/sponsor/ledger/release', {
    confirm: 'ENABLE_SPONSOR_MAINNET_WRITES',
  })
  assert.equal(result.status, 200, JSON.stringify({ payload: result.payload, database: db.state() }))
  assert.equal(result.payload.sponsorWritesPaused, false)
  assert.equal(result.payload.transactionExecutionAvailable, true)
  assert.equal(db.state().writesPaused, false)
  assert.equal(db.state().updateCount, 1)
})

test('Sponsor emergency pause requires Owner Admin but not Sponsor engine or release configuration', async () => {
  const databaseUrl = 'postgres://test_user:test_password@ep-test.ap-southeast-1.aws.neon.tech/sponsor?sslmode=require'
  const expectedDatabaseIdentitySha256 = sponsorDatabaseConnectionInfo({ DATABASE_URL: databaseUrl }).identityFingerprint
  const db = sponsorControlDatabase(false)
  const { api } = setup({ database: db.database, databaseUrl, expectedDatabaseIdentitySha256 })
  const result = await call(api, 'POST', '/api/sponsor/ledger/pause', {
    confirm: 'PAUSE_SPONSOR_MAINNET_WRITES',
  })
  assert.equal(result.status, 200, JSON.stringify(result.payload))
  assert.equal(result.payload.sponsorWritesPaused, true)
  assert.equal(result.payload.transactionExecutionAvailable, false)
  assert.equal(db.state().writesPaused, true)
  assert.equal(db.state().updateCount, 1)
})

test('Sponsor write release cannot be invoked without an authenticated Owner Admin session', async () => {
  let databaseQueries = 0
  const database = { async query() { databaseQueries += 1; throw new Error('database must not be touched without Owner Admin authorization') } }
  const databaseUrl = 'postgres://test_user:test_password@ep-test.ap-southeast-1.aws.neon.tech/sponsor?sslmode=require'
  const expectedDatabaseIdentitySha256 = sponsorDatabaseConnectionInfo({ DATABASE_URL: databaseUrl }).identityFingerprint
  const { api } = setup({
    database, databaseUrl, expectedDatabaseIdentitySha256,
    authenticateOwnerAdminSession: async () => null,
  })
  const result = await call(api, 'POST', '/api/sponsor/ledger/release', {
    confirm: 'ENABLE_SPONSOR_MAINNET_WRITES',
  }, null, null)
  assert.equal(result.status, 401)
  assert.equal(result.payload.error, 'admin-authorization-required')
  assert.equal(databaseQueries, 0)
})



test('production acceptance verifies Owner and Sponsor enrollment before Sponsor ledger bootstrap', async () => {
  const databaseUrl = 'postgres://test_user:test_password@ep-test.ap-southeast-1.aws.neon.tech/sponsor?sslmode=require'
  const expectedDatabaseIdentitySha256 = sponsorDatabaseConnectionInfo({ DATABASE_URL: databaseUrl }).identityFingerprint
  const database = {
    async query(sql) {
      if (sql.includes('SELECT wallet_role, wallet_address, enabled')) {
        return {
          rowCount: 2,
          rows: [
            { wallet_role: 'owner', wallet_address: OWNER, enabled: true },
            { wallet_role: 'sponsor', wallet_address: SPONSOR, enabled: true },
          ],
        }
      }
      if (sql.includes('to_regclass')) {
        return {
          rowCount: 1,
          rows: [{
            operations_table: null,
            control_table: null,
            prepared_transaction_column: false,
            signed_transaction_column: false,
          }],
        }
      }
      throw new Error('pre-bootstrap acceptance must remain read-only')
    },
  }
  const { api } = setup({ database, databaseUrl, expectedDatabaseIdentitySha256 })
  const result = await call(api, 'GET', '/api/acceptance/production')
  assert.equal(result.status, 200)
  assert.equal(result.payload.ownerWalletEnrolled, true)
  assert.equal(result.payload.sponsorWalletEnrolled, true)
  assert.equal(result.payload.acceptance.checks.find(check => check.id === 'owner-wallet-enrolled').state, 'passed')
  assert.equal(result.payload.acceptance.checks.find(check => check.id === 'sponsor-wallet-enrolled').state, 'passed')
  assert.equal(result.payload.acceptance.checks.find(check => check.id === 'ledger-schema-and-control-row').state, 'blocked')
  assert.equal(result.payload.sponsorWritesPaused, true)
  assert.equal(result.payload.transactionExecutionAvailable, false)
})


test('Sponsor readiness fails closed when the versioned ledger migration checksum is missing', async () => {
  const database = {
    async query(sql) {
      if (sql.includes('to_regclass')) return { rowCount: 1, rows: [{ operations_table: 'tron_transfer_sponsor_operations', control_table: 'tron_transfer_sponsor_control', prepared_transaction_column: true, signed_transaction_column: true }] }
      if (sql.includes('SELECT writes_paused')) return { rowCount: 1, rows: [{ writes_paused: true }] }
      throw new Error('status endpoint must remain read-only')
    },
  }
  const databaseUrl = 'postgres://test_user:test_password@ep-test.ap-southeast-1.aws.neon.tech/sponsor?sslmode=require'
  const expectedDatabaseIdentitySha256 = sponsorDatabaseConnectionInfo({ DATABASE_URL: databaseUrl }).identityFingerprint
  const { api } = setup({ database, databaseUrl, expectedDatabaseIdentitySha256, migrationChecksum: null })
  const result = await call(api, 'GET', '/api/sponsor/status')
  assert.equal(result.status, 200)
  assert.equal(result.payload.databaseReady, false)
  assert.equal(result.payload.databaseStatus, 'migration-checksum-unverified')
  assert.equal(result.payload.sponsorWritesPaused, true)
  assert.equal(result.payload.transactionExecutionAvailable, false)
})
