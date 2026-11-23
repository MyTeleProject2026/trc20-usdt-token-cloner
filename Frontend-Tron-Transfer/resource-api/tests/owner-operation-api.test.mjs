import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
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
    operationType: 'arbitrary-call', contractAddress: contract, idempotencyKey: 'owner-op-test-key-0001', feeLimitSun: '1000000',
  }), response(), new URL('https://api.test/api/owner/operations/prepare'), 'https://tron-transfer.onrender.com')
  assert.equal(replies[0].status, 400)
  assert.equal(replies[0].payload.error, 'OWNER_OPERATION_NOT_ALLOWLISTED')
})

test('Owner operation preparation API contains no signing or broadcast path', async () => {
  const source = await readFile(new URL('../owner-operation-api.mjs', import.meta.url), 'utf8')
  assert.match(source, /executionGateEnabled\(env\)/)
  assert.match(source, /OWNER_ZERO_TRX_BURN_PREFLIGHT_BLOCKED/)
  assert.match(source, /TRAX_RUNTIME_BYTECODE_SHA256/)
  assert.match(source, /signer\.signContractTransaction/)
  assert.match(source, /broadcastTransaction/)
  assert.match(source, /walletsolidity\/gettransactioninfobyid/)
})

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  return JSON.stringify(value)
}
function makeExecutionFixture(overrides = {}) {
  const intent = { method: 'setPaused', args: [true], feeLimitSun: '1000000' }
  const intentSha256 = createHash('sha256').update('pause:' + canonical(intent)).digest('hex')
  const operation = {
    operation_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    session_id: 9, idempotency_key: 'owner-operation-test-00001',
    operation_type: 'pause', contract_address: contract, intent, intent_sha256: intentSha256,
    state: 'awaiting-confirmation', transaction_id: null, receipt: {},
  }
  const transitions = []
  const counts = { sign: 0, broadcast: 0, preflight: 0, verify: 0, signatureCheck: 0 }
  const ledger = {
    async get() { return { ...operation, state: transitions.at(-1)?.state || operation.state } },
    async claimConfirmation() { operation.state = 'confirming'; return { ...operation } },
    async transition(input) {
      transitions.push({ state: input.nextState, ...input })
      operation.state = input.nextState
      if (input.transactionId) operation.transaction_id = input.transactionId
      return { state: input.nextState }
    },
  }
  const api = createOwnerOperationApi({
    env: {
      TRON_OWNER_ADDRESS: owner, TRAX_CONTRACT_ADDRESS: contract,
      OWNER_OPERATION_LEDGER_DURABLE: 'true',
      OWNER_OPERATION_LEDGER_BACKUP_VERIFIED: 'true',
      OWNER_OPERATION_LEDGER_RESTORE_TESTED: 'true',
      OWNER_OPERATION_EXECUTION_ENABLED: 'true',
      OWNER_OPERATION_MAINNET_ACK: 'CONFIRM_GUARDED_OWNER_EXECUTION',
      ...overrides.env,
    },
    database: { async query() { return { rows: [{ operations_table: 'tron_transfer_owner_operations' }] } } },
    send: (_res, status, payload) => replies.push({ status, payload }),
    authenticateManagedSession: async () => ({ address: owner, sessionId: 9 }),
    ledgerFactory: () => ledger,
    tronWebFactory: () => ({ trx: {} }),
    verifyContractState: async () => { counts.verify++ },
    verifySignedTransaction: async () => { counts.signatureCheck++; if (overrides.signatureFailure) throw Object.assign(new Error('signature rejected'), { code: 'OWNER_SIGNED_TRANSACTION_PERMISSION_INVALID', status: 403 }) },
    prepareTransaction: async () => ({ txID: 'b'.repeat(64), raw_data: { expiration: Date.now() + 60_000 } }),
    preflightTransaction: async () => { counts.preflight++; if (overrides.preflightFailure) throw Object.assign(new Error('blocked'), { code: 'OWNER_ZERO_TRX_BURN_PREFLIGHT_BLOCKED', status: 423 }); return { estimatedTrxFallbackSun: '0' } },
    signerFactory: () => ({
      address: owner, network: 'TRON Mainnet',
      async signContractTransaction(unsigned) { counts.sign++; return { ...unsigned, signature: ['a'.repeat(130)] } },
    }),
    broadcastTransaction: async (_tronWeb, signed) => { counts.broadcast++; return { result: true, txid: signed.txID } },
    reconcileTransaction: async () => ({ solidified: true, success: true, status: 'SUCCESS', blockNumber: 123 }),
  })
  const replies = []
  return { api, operation, intentSha256, transitions, counts, replies }
}

test('Owner confirmation signs once, durably journals before broadcast and verifies solidified receipt', async () => {
  const fixture = makeExecutionFixture()
  const req = request('POST', {
    confirmationPhrase: 'CONFIRM TRON MAINNET OWNER OPERATION',
    intentSha256: fixture.intentSha256,
    contractAddress: contract,
  })
  await fixture.api.handle(req, response(), new URL('https://api.test/api/owner/operations/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11/confirm'), 'https://tron-transfer.onrender.com')
  assert.equal(fixture.replies[0].status, 200)
  assert.equal(fixture.replies[0].payload.state, 'confirmed')
  assert.equal(fixture.counts.sign, 1)
  assert.equal(fixture.counts.broadcast, 1)
  assert.equal(fixture.counts.signatureCheck, 1)
  assert.deepEqual(fixture.transitions.map(item => item.state), ['signed', 'broadcast-unknown', 'broadcast', 'confirmed'])
})

test('Owner confirmation rejects a mismatched phrase or intent hash before claiming or signing', async () => {
  const fixture = makeExecutionFixture()
  await fixture.api.handle(request('POST', {
    confirmationPhrase: 'WRONG PHRASE', intentSha256: fixture.intentSha256, contractAddress: contract,
  }), response(), new URL('https://api.test/api/owner/operations/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11/confirm'), 'https://tron-transfer.onrender.com')
  assert.equal(fixture.replies[0].status, 400)
  assert.equal(fixture.counts.sign, 0)
  assert.equal(fixture.counts.broadcast, 0)
  assert.equal(fixture.transitions.length, 0)
})

test('Owner confirmation fails closed on a fresh resource shortfall without signing or broadcast', async () => {
  const fixture = makeExecutionFixture({ preflightFailure: true })
  await fixture.api.handle(request('POST', {
    confirmationPhrase: 'CONFIRM TRON MAINNET OWNER OPERATION',
    intentSha256: fixture.intentSha256, contractAddress: contract,
  }), response(), new URL('https://api.test/api/owner/operations/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11/confirm'), 'https://tron-transfer.onrender.com')
  assert.equal(fixture.replies[0].status, 423)
  assert.equal(fixture.counts.sign, 0)
  assert.equal(fixture.counts.broadcast, 0)
  assert.equal(fixture.transitions.at(-1).state, 'failed')
})

test('Owner confirmation remains disabled without both explicit Mainnet execution gates', async () => {
  const fixture = makeExecutionFixture({ env: { OWNER_OPERATION_MAINNET_ACK: '' } })
  await fixture.api.handle(request('POST', {}), response(), new URL('https://api.test/api/owner/operations/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11/confirm'), 'https://tron-transfer.onrender.com')
  assert.equal(fixture.replies[0].status, 423)
  assert.equal(fixture.counts.sign, 0)
  assert.equal(fixture.counts.broadcast, 0)
})

test('Owner confirmation never broadcasts if recovered signature or permission evidence fails', async () => {
  const fixture = makeExecutionFixture({ signatureFailure: true })
  await fixture.api.handle(request('POST', {
    confirmationPhrase: 'CONFIRM TRON MAINNET OWNER OPERATION',
    intentSha256: fixture.intentSha256, contractAddress: contract,
  }), response(), new URL('https://api.test/api/owner/operations/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11/confirm'), 'https://tron-transfer.onrender.com')
  assert.equal(fixture.replies[0].status, 403)
  assert.equal(fixture.counts.sign, 1)
  assert.equal(fixture.counts.signatureCheck, 1)
  assert.equal(fixture.counts.broadcast, 0)
  assert.equal(fixture.transitions.at(-1).state, 'failed')
})
