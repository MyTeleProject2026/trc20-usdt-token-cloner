import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createSponsorResourceApi, sponsorDatabaseConnectionInfo, sponsorDatabaseConnectionString } from '../sponsor-api.mjs'

const SPONSOR = 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL'
const OWNER = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const SECRET = 'test-session-secret-with-at-least-thirty-two-bytes'
const SIGNATURE = 'a'.repeat(130)
const TEST_ADMIN_TOKEN = 'test-admin-token-with-at-least-thirty-two-bytes'

function request(method, path, body, token, adminToken) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  stream.method = method
  stream.url = path
  stream.headers = { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(adminToken ? { 'x-sponsor-admin-token': adminToken } : {}) }
  stream.socket = { remoteAddress: '127.0.0.1' }
  return stream
}
function response() {
  return { status: 0, payload: null }
}
function setup({ database = null, engine = null, adminToken = TEST_ADMIN_TOKEN, databaseUrl = '' } = {}) {
  const env = {
    SPONSOR_SESSION_SECRET: SECRET,
    SPONSOR_LEDGER_DURABLE: 'true',
    SPONSOR_LEDGER_BACKUP_VERIFIED: 'true',
    SPONSOR_LEDGER_RESTORE_TESTED: 'true',
    ...(adminToken ? { SPONSOR_ADMIN_TOKEN: adminToken } : {}),
    SPONSOR_MAINNET_ADDRESS: SPONSOR,
    TRON_OWNER_ADDRESS: OWNER,
    ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
    SPONSOR_TRANSACTION_ENGINE_ENABLED: 'false',
    SPONSOR_MAINNET_BROADCAST_ENABLED: 'false',
  }
  const calls = []
  const api = createSponsorResourceApi({
    env,
    allowedAddress: OWNER,
    getDatabase: () => database,
    engine: engine || {
      readiness: () => ({ configured: false, enabled: false, broadcastAvailable: false, feePolicy: {} }),
      execute: async () => { calls.push('execute'); return { success: true } },
      reconcile: async () => ({ confirmed: false, status: 'not-solidified' }),
    },
    verifyMessage: async (message, signature) => signature === SIGNATURE ? SPONSOR : '',
    send: (res, status, payload) => { res.status = status; res.payload = payload },
    now: () => Date.now(),
  })
  return { api, calls, env }
}
async function call(api, method, path, body, token, adminToken = TEST_ADMIN_TOKEN) {
  const res = response()
  const handled = await api.handle(request(method, path, body, token, adminToken), res, new URL(path, 'http://localhost'), null)
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
  })
  assert.equal(sponsorDatabaseConnectionString(env), env.SPONSOR_DATABASE_URL_POOLED)

  const direct = sponsorDatabaseConnectionInfo({ DATABASE_URL: 'postgres://user:password@db.render.com/sponsor' })
  assert.deepEqual(direct, {
    configured: true,
    sourceVariable: 'DATABASE_URL',
    provider: 'render-postgres',
    connectionMode: 'direct',
  })
  assert.deepEqual(sponsorDatabaseConnectionInfo({}), {
    configured: false,
    sourceVariable: null,
    provider: 'not-configured',
    connectionMode: 'unknown',
  })
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
  })
  const serialized = JSON.stringify(result.payload)
  assert.equal(serialized.includes('neon_secret'), false)
  assert.equal(serialized.includes('ep-private'), false)
  assert.equal(serialized.includes('neon.tech'), false)
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

test('Sponsor status exposes readiness but never secret values', async () => {
  const { api } = setup()
  const result = await call(api, 'GET', '/api/sponsor/status')
  assert.equal(result.status, 200)
  assert.equal(result.payload.network, 'TRON Mainnet')
  assert.equal(result.payload.sponsorAddress, SPONSOR)
  assert.equal(result.payload.transactionExecutionAvailable, false)
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
  const { api } = setup({ database, databaseUrl: 'postgres://configured' })
  const result = await call(api, 'GET', '/api/sponsor/status')
  assert.equal(result.status, 200)
  assert.equal(result.payload.databaseConfigured, true)
  assert.equal(result.payload.databaseReady, false)
  assert.equal(result.payload.databaseStatus, 'schema-missing')
  assert.equal(result.payload.sponsorWritesPaused, true)
  assert.equal(result.payload.transactionExecutionAvailable, false)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].trimStart().startsWith('CREATE'), false)
})

test('Sponsor ledger bootstrap requires admin authorization and leaves writes paused', async () => {
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
  const { api } = setup({ database, databaseUrl: 'postgres://configured' })
  const denied = await call(api, 'POST', '/api/sponsor/ledger/bootstrap', {}, null, '')
  assert.equal(denied.status, 401)
  assert.equal(schemaCreated, false)

  const initialized = await call(api, 'POST', '/api/sponsor/ledger/bootstrap', {}, null, TEST_ADMIN_TOKEN)
  assert.equal(initialized.status, 200)
  assert.equal(initialized.payload.schemaInitialized, true)
  assert.equal(initialized.payload.databaseReady, true)
  assert.equal(initialized.payload.sponsorWritesPaused, true)
  assert.equal(initialized.payload.transactionExecutionAvailable, false)
  assert.equal(schemaCreated, true)
})

test('Sponsor operation history reads never bootstrap or mutate the ledger schema', async () => {
  const queries = []
  const database = {
    async query(sql) {
      queries.push(sql)
      if (sql.includes('to_regclass')) {
        return { rowCount: 1, rows: [{ operations_table: 'tron_transfer_sponsor_operations', control_table: 'tron_transfer_sponsor_control' }] }
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
  assert.equal(queries.some(sql => /CREATE|ALTER|DROP|INSERT|UPDATE/i.test(sql)), false)
})

test('Sponsor status fails closed when the ledger control row is missing', async () => {
  const database = {
    async query(sql) {
      if (sql.includes('to_regclass')) {
        return { rowCount: 1, rows: [{ operations_table: 'tron_transfer_sponsor_operations', control_table: 'tron_transfer_sponsor_control' }] }
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
  const { api } = setup({ database, databaseUrl: 'postgres://configured', engine })
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

test('invalid configured Sponsor Admin token keeps write execution unavailable', async () => {
  const database = {
    async query(sql) {
      if (sql.includes('to_regclass')) return { rowCount: 1, rows: [{ operations_table: 'tron_transfer_sponsor_operations', control_table: 'tron_transfer_sponsor_control' }] }
      if (sql.includes('SELECT writes_paused')) return { rowCount: 1, rows: [{ writes_paused: false }] }
      throw new Error('status endpoint must not mutate the Sponsor ledger schema')
    },
  }
  const engine = {
    readiness: () => ({ configured: true, enabled: true, broadcastAvailable: true, ownerAddress: OWNER, feePolicy: {} }),
    execute: async () => assert.fail('execution must remain disabled'),
    reconcile: async () => ({ confirmed: false, status: 'not-solidified' }),
  }
  const { api } = setup({ database, databaseUrl: 'postgres://configured', engine, adminToken: 'too-short' })
  const result = await call(api, 'GET', '/api/sponsor/status')
  assert.equal(result.status, 200)
  assert.equal(result.payload.adminTokenRequired, true)
  assert.equal(result.payload.adminTokenConfigured, false)
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

test('unsigned or invalid intent signatures cannot invoke the transaction engine', async () => {
  const { api, calls } = setup()
  const token = await authenticated(api)
  const intent = await call(api, 'POST', '/api/sponsor/intent', {
    operation: 'stake', resource: 'ENERGY', amountSun: '1000000', idempotencyKey: 'sponsor-op-0123456789012345',
  }, token)
  const result = await call(api, 'POST', '/api/sponsor/operations', {
    intentId: intent.payload.intentId, signature: 'invalid', confirmPhrase: 'CONFIRM TRON MAINNET SPONSOR TRANSACTION',
  }, token)
  assert.equal(result.status, 400)
  assert.deepEqual(calls, [])
})

test('valid signed intent still fails closed when durable idempotency storage is unavailable', async () => {
  const { api, calls } = setup()
  const token = await authenticated(api)
  const intent = await call(api, 'POST', '/api/sponsor/intent', {
    operation: 'stake', resource: 'ENERGY', amountSun: '1000000', idempotencyKey: 'sponsor-op-0123456789012345',
  }, token)
  const result = await call(api, 'POST', '/api/sponsor/operations', {
    intentId: intent.payload.intentId, signature: SIGNATURE, confirmPhrase: 'CONFIRM TRON MAINNET SPONSOR TRANSACTION',
  }, token)
  assert.equal(result.status, 503)
  assert.deepEqual(calls, [])
})

test('durable Sponsor maintenance pause blocks a valid signed operation before reservation or signing', async () => {
  const database = {
    async query(sql) {
      if (sql.includes('to_regclass')) return { rowCount: 1, rows: [{ operations_table: 'tron_transfer_sponsor_operations', control_table: 'tron_transfer_sponsor_control' }] }
      if (sql.trimStart().startsWith('CREATE TABLE') || sql.trimStart().startsWith('CREATE INDEX') || sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SELECT 1') return { rowCount: 0, rows: [] }
      if (sql.includes('SELECT writes_paused')) return { rowCount: 1, rows: [{ writes_paused: true }] }
      throw new Error('unexpected fake database query: ' + sql)
    },
  }
  const engine = {
    readiness: () => ({ configured: true, enabled: true, broadcastAvailable: true, ownerAddress: OWNER, sponsorAddress: SPONSOR, feePolicy: {} }),
    execute: async () => assert.fail('paused Sponsor engine must never sign or broadcast'),
    reconcile: async () => ({ confirmed: false, status: 'not-solidified' }),
  }
  const { api } = setup({ database, databaseUrl: 'postgres://configured', engine })
  const status = await call(api, 'GET', '/api/sponsor/status')
  assert.equal(status.payload.sponsorWritesPaused, true)
  assert.equal(status.payload.databaseStatus, 'ready')
  assert.equal(status.payload.transactionExecutionAvailable, false)
  const token = await authenticated(api)
  const intent = await call(api, 'POST', '/api/sponsor/intent', {
    operation: 'delegate', resource: 'ENERGY', amountSun: '1000000', idempotencyKey: 'sponsor-pause-0123456789012345',
  }, token)
  const result = await call(api, 'POST', '/api/sponsor/operations', {
    intentId: intent.payload.intentId, signature: SIGNATURE, confirmPhrase: 'CONFIRM TRON MAINNET SPONSOR TRANSACTION',
  }, token)
  assert.equal(result.status, 423)
  assert.equal(result.payload.error, 'sponsor-writes-paused-for-maintenance')
})

test('expired or reused intent cannot be executed twice', async () => {
  const { api, calls } = setup()
  const token = await authenticated(api)
  const intent = await call(api, 'POST', '/api/sponsor/intent', {
    operation: 'delegate', resource: 'BANDWIDTH', amountSun: '1000000', idempotencyKey: 'sponsor-op-0123456789012345',
  }, token)
  const body = { intentId: intent.payload.intentId, signature: SIGNATURE, confirmPhrase: 'wrong phrase' }
  const first = await call(api, 'POST', '/api/sponsor/operations', body, token)
  assert.equal(first.status, 400)
  const replay = await call(api, 'POST', '/api/sponsor/operations', body, token)
  assert.equal(replay.status, 409)
  assert.deepEqual(calls, [])
})

test('durable Sponsor idempotency prevents a second signer invocation for the same exact intent', async () => {
  const rows = new Map()
  const database = {
    async query(sql, params = []) {
      if (sql.includes('to_regclass')) return { rowCount: 1, rows: [{ operations_table: 'tron_transfer_sponsor_operations', control_table: 'tron_transfer_sponsor_control' }] }
      if (sql.trimStart().startsWith('CREATE TABLE') || sql.trimStart().startsWith('CREATE INDEX')
        || ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] }
      if (sql.includes('SELECT writes_paused')) return { rowCount: 1, rows: [{ writes_paused: false }] }
      if (sql.startsWith('INSERT INTO public.tron_transfer_sponsor_operations')) {
        const [keyHash, requestHash, operation, resource, amountSun, sponsorAddress, ownerAddress] = params
        if (rows.has(keyHash)) return { rowCount: 0, rows: [] }
        rows.set(keyHash, { idempotency_key_hash: keyHash, request_hash: requestHash, operation, resource, amount_sun: amountSun, sponsor_address: sponsorAddress, owner_address: ownerAddress, status: 'reserved', transaction_id: null })
        return { rowCount: 1, rows: [{ id: 1 }] }
      }
      if (sql.startsWith('SELECT request_hash,status,transaction_id,result_code,confirmation_block')) {
        const row = rows.get(params[0])
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] }
      }
      if (sql.startsWith("UPDATE public.tron_transfer_sponsor_operations SET status='broadcast-unknown'")) {
        const row = rows.get(params[0])
        if (!row || row.status !== 'reserved') return { rowCount: 0, rows: [] }
        row.status = 'broadcast-unknown'
        row.transaction_id = params[1]
        return { rowCount: 1, rows: [{ id: 1 }] }
      }
      if (sql.startsWith('UPDATE public.tron_transfer_sponsor_operations SET status=$2')) {
        const row = rows.get(params[0])
        if (!row) return { rowCount: 0, rows: [] }
        row.status = params[1]
        row.transaction_id = params[2] || row.transaction_id
        row.result_code = params[3]
        row.confirmation_block = params[4]
        return { rowCount: 1, rows: [] }
      }
      throw new Error('unexpected fake database query: ' + sql)
    },
  }
  let executions = 0
  const engine = {
    readiness: () => ({ configured: true, enabled: true, broadcastAvailable: true, ownerAddress: OWNER, sponsorAddress: SPONSOR, feePolicy: {} }),
    execute: async ({ onSigned }) => {
      executions += 1
      await onSigned('b'.repeat(64))
      return { success: true, status: 'solidified-success', txid: 'b'.repeat(64), signed: true, broadcast: true, solidified: true, blockNumber: 456 }
    },
    reconcile: async () => ({ confirmed: true, status: 'solidified-success', blockNumber: 456 }),
  }
  const { api } = setup({ database, engine })
  const token = await authenticated(api)
  const idempotencyKey = 'sponsor-idempotency-012345678901'
  const createIntent = () => call(api, 'POST', '/api/sponsor/intent', {
    operation: 'delegate', resource: 'ENERGY', amountSun: '127852400', idempotencyKey,
  }, token)
  const firstIntent = await createIntent()
  const first = await call(api, 'POST', '/api/sponsor/operations', {
    intentId: firstIntent.payload.intentId, signature: SIGNATURE, confirmPhrase: 'CONFIRM TRON MAINNET SPONSOR TRANSACTION',
  }, token)
  assert.equal(first.status, 200)
  assert.equal(first.payload.operationStatus, 'confirmed')
  assert.equal(first.payload.transactionId, 'b'.repeat(64))
  const secondIntent = await createIntent()
  const second = await call(api, 'POST', '/api/sponsor/operations', {
    intentId: secondIntent.payload.intentId, signature: SIGNATURE, confirmPhrase: 'CONFIRM TRON MAINNET SPONSOR TRANSACTION',
  }, token)
  assert.equal(second.status, 409)
  assert.equal(second.payload.error, 'operation-already-recorded')
  assert.equal(executions, 1)
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


test('configured Sponsor Admin token is required as a second factor for write intents', async () => {
  const adminToken = 'admin-token-with-at-least-thirty-two-bytes-long'
  const { api } = setup({ adminToken })
  const token = await authenticated(api)
  const body = {
    operation: 'topup', resource: 'TRX', amountSun: '1000000',
    idempotencyKey: 'sponsor-admin-topup-0123456789',
  }
  const denied = await call(api, 'POST', '/api/sponsor/intent', body, token, null)
  assert.equal(denied.status, 403)
  assert.equal(denied.payload.error, 'sponsor-admin-authorization-required')
  const accepted = await call(api, 'POST', '/api/sponsor/intent', body, token, adminToken)
  assert.equal(accepted.status, 201)
})


test('Sponsor writes fail closed until ledger durability, backup and restore are verified', async () => {
  const { api } = setup()
  const token = await authenticated(api)
  const status = await call(api, 'GET', '/api/sponsor/status')
  assert.equal(status.payload.ledgerDurabilityVerified, true)

  const { api: unverifiedApi, env: unverifiedEnv } = setup()
  const unverifiedToken = await authenticated(unverifiedApi)
  const prepared = await call(unverifiedApi, 'POST', '/api/sponsor/intent', {
    operation: 'delegate', resource: 'ENERGY', amountSun: '1000000',
    idempotencyKey: 'sponsor-unverified-ledger-0123456789',
  }, unverifiedToken)
  assert.equal(prepared.status, 201)

  unverifiedEnv.SPONSOR_LEDGER_DURABLE = 'false'
  const unverifiedStatus = await call(unverifiedApi, 'GET', '/api/sponsor/status')
  assert.equal(unverifiedStatus.payload.ledgerDurabilityVerified, false)
  assert.equal(unverifiedStatus.payload.transactionExecutionAvailable, false)

  const intent = await call(unverifiedApi, 'POST', '/api/sponsor/intent', {
    operation: 'delegate', resource: 'ENERGY', amountSun: '1000000',
    idempotencyKey: 'sponsor-unverified-ledger-second-012345',
  }, unverifiedToken)
  assert.equal(intent.status, 503)
  assert.equal(intent.payload.error, 'sponsor-ledger-durability-not-verified')

  const execution = await call(unverifiedApi, 'POST', '/api/sponsor/operations', {
    intentId: prepared.payload.intentId,
    signature: SIGNATURE,
    confirmPhrase: prepared.payload.confirmationPhrase,
  }, unverifiedToken)
  assert.equal(execution.status, 503)
  assert.equal(execution.payload.error, 'sponsor-ledger-durability-not-verified')
})

test('missing Sponsor Admin token configuration fails closed for every write', async () => {
  const { api } = setup({ adminToken: '' })
  const status = await call(api, 'GET', '/api/sponsor/status')
  assert.equal(status.payload.adminTokenRequired, true)
  assert.equal(status.payload.adminTokenConfigured, false)
  assert.equal(status.payload.transactionExecutionAvailable, false)
  const token = await authenticated(api)
  const result = await call(api, 'POST', '/api/sponsor/intent', {
    operation: 'delegate', resource: 'ENERGY', amountSun: '1000000',
    idempotencyKey: 'sponsor-missing-admin-factor-012345',
  }, token, null)
  assert.equal(result.status, 403)
  assert.equal(result.payload.error, 'sponsor-admin-authorization-required')
})

test('Sponsor Admin token comparison is required for execution route too', async () => {
  const adminToken = 'admin-token-with-at-least-thirty-two-bytes-long'
  const { api, calls } = setup({ adminToken })
  const token = await authenticated(api)
  const result = await call(api, 'POST', '/api/sponsor/operations', {
    intentId: 'untrusted-intent', signature: SIGNATURE, confirmPhrase: 'CONFIRM TRON MAINNET SPONSOR TRANSACTION',
  }, token)
  assert.equal(result.status, 403)
  assert.deepEqual(calls, [])
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
