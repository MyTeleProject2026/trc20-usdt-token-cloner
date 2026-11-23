import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createOwnerOperationApi } from '../owner-operation-api.mjs'

const owner = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const contract = 'TQn9Y2khEsLJW1ChVWFMSMeNT3h6vTq6t4'

function request(method = 'GET', payload = {}) {
  return {
    method,
    headers: {},
    async *[Symbol.asyncIterator]() {
      if (method === 'POST') yield Buffer.from(JSON.stringify(payload))
    },
  }
}
function response() {
  return {
    status: 0, body: '',
    writeHead(status) { this.status = status },
    end(value) { this.body = value || '' },
  }
}
function makeApi({ env = {}, session = null, database = null, authenticateManagedSession } = {}) {
  const replies = []
  const authCalls = []
  const api = createOwnerOperationApi({
    env,
    database,
    send: (_res, status, payload) => { replies.push({ status, payload }) },
    authenticateManagedSession: authenticateManagedSession || (async (_req, options) => {
      authCalls.push(options)
      return session
    }),
    tronWebFactory: () => { throw new Error('unexpected-tronweb-construction') },
    prepareTransaction: async () => { throw new Error('unexpected-transaction-build') },
    preflightTransaction: async () => { throw new Error('unexpected-mainnet-preflight') },
  })
  return { api, replies, authCalls }
}

test('Owner operation API ignores unrelated paths without authenticating', async () => {
  const { api, authCalls } = makeApi()
  assert.equal(await api.handle(request(), response(), new URL('https://api.test/api/owner/status'), null), false)
  assert.equal(authCalls.length, 0)
})

test('Owner operation preparation requires an authenticated Owner session and CSRF', async () => {
  const { api, replies, authCalls } = makeApi()
  await api.handle(request('POST'), response(), new URL('https://api.test/api/owner/operations/prepare'), 'https://tron-transfer.onrender.com')
  assert.deepEqual(authCalls, [{ requireCsrf: true }])
  assert.equal(replies[0].status, 401)
  assert.equal(replies[0].payload.error, 'OWNER_SESSION_REQUIRED')
})

test('Owner operation API rejects a session that is not the configured Mainnet owner', async () => {
  const { api, replies } = makeApi({
    env: { TRON_OWNER_ADDRESS: owner },
    session: { address: 'TSPz5ULCfd4zbMUCfF337KWyia8F1F5kYR', sessionId: 4 },
  })
  await api.handle(request('POST'), response(), new URL('https://api.test/api/owner/operations/prepare'), 'https://tron-transfer.onrender.com')
  assert.equal(replies[0].status, 401)
  assert.equal(replies[0].payload.error, 'OWNER_SESSION_REQUIRED')
})

test('Owner operation preparation fails closed until ledger backup and restore are verified', async () => {
  const database = { async query() { throw new Error('database should not be queried before durability gate') } }
  const { api, replies } = makeApi({
    env: { TRON_OWNER_ADDRESS: owner },
    session: { address: owner, sessionId: 4 },
    database,
  })
  await api.handle(request('POST'), response(), new URL('https://api.test/api/owner/operations/prepare'), 'https://tron-transfer.onrender.com')
  assert.equal(replies[0].status, 503)
  assert.equal(replies[0].payload.error, 'OWNER_OPERATION_LEDGER_DURABILITY_NOT_VERIFIED')
})

test('Owner operation preparation rejects arbitrary operations before building a transaction', async () => {
  const database = { async query(sql) {
    assert.match(sql, /to_regclass/)
    return { rows: [{ operations_table: 'tron_transfer_owner_operations' }] }
  } }
  const { api, replies } = makeApi({
    env: {
      TRON_OWNER_ADDRESS: owner,
      TRAX_CONTRACT_ADDRESS: contract,
      OWNER_OPERATION_LEDGER_DURABLE: 'true',
      OWNER_OPERATION_LEDGER_BACKUP_VERIFIED: 'true',
      OWNER_OPERATION_LEDGER_RESTORE_TESTED: 'true',
    },
    session: { address: owner, sessionId: 4 },
    database,
  })
  await api.handle(request('POST', {
    operationType: 'arbitrary-call', idempotencyKey: 'owner-op-test-key-0001', feeLimitSun: '1000000',
  }), response(), new URL('https://api.test/api/owner/operations/prepare'), 'https://tron-transfer.onrender.com')
  assert.equal(replies[0].status, 400)
  assert.equal(replies[0].payload.error, 'OWNER_OPERATION_NOT_ALLOWLISTED')
})

test('Owner operation preparation API contains no signing or broadcast path', async () => {
  const source = await readFile(new URL('../owner-operation-api.mjs', import.meta.url), 'utf8')
  assert.match(source, /executionEnabled: false/)
  assert.match(source, /OWNER_ZERO_TRX_BURN_PREFLIGHT_BLOCKED/)
  assert.match(source, /TRAX_RUNTIME_BYTECODE_SHA256/)
  assert.doesNotMatch(source, /sendRawTransaction|signContractTransaction/)
})
