import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createOwnerOperationApi } from '../owner-operation-api.mjs'
import { sponsorDatabaseTargetIdentityInfo } from '../sponsor-api.mjs'

const owner = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const contract = 'TQn9Y2khEsLJW1ChVWFMSMeNT3h6vTq6t4'
const testDatabaseUrl = 'postgres://test_user:test_password@ep-test.ap-southeast-1.aws.neon.tech/sponsor?sslmode=require'
const testDatabaseIdentity = sponsorDatabaseTargetIdentityInfo({ DATABASE_URL: testDatabaseUrl }).identityFingerprint

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
    env: { DATABASE_URL: testDatabaseUrl, OWNER_ADMIN_EXPECTED_DATABASE_IDENTITY_SHA256: testDatabaseIdentity, ...env },
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

test('Owner operation ledger fails closed when its database target differs from the approved fingerprint', async () => {
  const database = { async query() { throw new Error('database must not be touched on identity mismatch') } }
  const { api, replies } = makeApi({
    env: { TRON_OWNER_ADDRESS: owner, OWNER_ADMIN_EXPECTED_DATABASE_IDENTITY_SHA256: 'f'.repeat(64) },
    session: { address: owner, sessionId: 4 },
    database,
  })
  await api.handle(request('POST', {
    operationType: 'mint', contractAddress: contract, idempotencyKey: 'owner-op-db-identity-0001', feeLimitSun: '1000000',
  }), response(), new URL('https://api.test/api/owner/operations/prepare'), 'https://tron-transfer.onrender.com')
  assert.equal(replies[0].status, 503)
  assert.equal(replies[0].payload.error, 'OWNER_OPERATION_DATABASE_IDENTITY_NOT_ACCEPTED')
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

test('Official USDT withdrawal preparation is pinned to the canonical Mainnet contract and shared Owner ledger', async () => {
  const usdtContract = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
  const recipient = 'TSPz5ULCfd4zbMUCfF337KWyia8F1F5kYR'
  const replies = []
  const transitions = []
  const calls = { verifyUsdt: 0, verifyTrax: 0, prepared: null }
  const ledger = {
    async prepare(input) {
      calls.ledgerInput = input
      return { operation_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', state: 'created', intent_sha256: 'a'.repeat(64), replay: false }
    },
    async transition(input) { transitions.push(input); return { state: input.nextState } },
    async get() { return null },
  }
  const api = createOwnerOperationApi({
    env: {
      DATABASE_URL: testDatabaseUrl,
      OWNER_ADMIN_EXPECTED_DATABASE_IDENTITY_SHA256: testDatabaseIdentity,
      TRON_OWNER_ADDRESS: owner,
      TRAX_CONTRACT_ADDRESS: contract,
      OWNER_OPERATION_LEDGER_DURABLE: 'true',
      OWNER_OPERATION_LEDGER_BACKUP_VERIFIED: 'true',
      OWNER_OPERATION_LEDGER_RESTORE_TESTED: 'true',
    },
    database: { async query() { return { rows: [{ operations_table: 'tron_transfer_owner_operations' }] } } },
    send: (_res, status, payload) => replies.push({ status, payload }),
    authenticateManagedSession: async () => ({ address: owner, sessionId: 9 }),
    ledgerFactory: () => ledger,
    tronWebFactory: () => ({}),
    verifyUsdtContractState: async (_tronWeb, address) => { calls.verifyUsdt++; assert.equal(address, usdtContract) },
    verifyContractState: async () => { calls.verifyTrax++; throw new Error('TRAX verification must not be used for USDT') },
    prepareTransaction: async (_tronWeb, address, ownerAddress, normalized) => {
      calls.prepared = { address, ownerAddress, normalized }
      return { txID: 'b'.repeat(64), raw_data_hex: 'ab'.repeat(32), raw_data: { expiration: Date.now() + 60_000 } }
    },
    preflightTransaction: async () => ({ estimatedTrxFallbackSun: '0', requiredEnergyWithSafetyMargin: 12000 }),
  })
  await api.handle(request('POST', {
    operationType: 'usdt-transfer',
    contractAddress: usdtContract,
    recipient,
    amount: '1250000',
    feeLimitSun: '1000000',
    idempotencyKey: 'owner-usdt-withdrawal-0001',
  }), response(), new URL('https://api.test/api/owner/operations/prepare'), 'https://tron-transfer.onrender.com')
  assert.equal(replies[0].status, 201)
  assert.equal(replies[0].payload.operationType, 'usdt-transfer')
  assert.equal(replies[0].payload.contractAddress, usdtContract)
  assert.equal(calls.verifyUsdt, 1)
  assert.equal(calls.verifyTrax, 0)
  assert.equal(calls.prepared.address, usdtContract)
  assert.equal(calls.prepared.normalized.method, 'transfer')
  assert.deepEqual(calls.prepared.normalized.args, [recipient, '1250000'])
  assert.equal(calls.ledgerInput.operationType, 'usdt-transfer')
  assert.deepEqual(transitions.map(item => item.nextState), ['preflight-passed', 'awaiting-confirmation'])
})

test('Official USDT withdrawal refuses a non-canonical token contract before transaction preparation', async () => {
  const replies = []
  const api = createOwnerOperationApi({
    env: {
      DATABASE_URL: testDatabaseUrl,
      OWNER_ADMIN_EXPECTED_DATABASE_IDENTITY_SHA256: testDatabaseIdentity,
      TRON_OWNER_ADDRESS: owner,
      TRAX_CONTRACT_ADDRESS: contract,
      OWNER_OPERATION_LEDGER_DURABLE: 'true',
      OWNER_OPERATION_LEDGER_BACKUP_VERIFIED: 'true',
      OWNER_OPERATION_LEDGER_RESTORE_TESTED: 'true',
    },
    database: { async query() { return { rows: [{ operations_table: 'tron_transfer_owner_operations' }] } } },
    send: (_res, status, payload) => replies.push({ status, payload }),
    authenticateManagedSession: async () => ({ address: owner, sessionId: 9 }),
    tronWebFactory: () => { throw new Error('must not construct TronWeb for an invalid token address') },
    prepareTransaction: async () => { throw new Error('must not prepare an invalid token address') },
  })
  await api.handle(request('POST', {
    operationType: 'usdt-transfer',
    contractAddress: contract,
    recipient: 'TSPz5ULCfd4zbMUCfF337KWyia8F1F5kYR',
    amount: '1000000',
    feeLimitSun: '1000000',
    idempotencyKey: 'owner-usdt-withdrawal-0002',
  }), response(), new URL('https://api.test/api/owner/operations/prepare'), 'https://tron-transfer.onrender.com')
  assert.equal(replies[0].status, 409)
  assert.equal(replies[0].payload.error, 'OWNER_USDT_CONTRACT_ADDRESS_NOT_OFFICIAL')
})

test('Owner operation API exposes signing only behind guarded explicit confirmation', async () => {
  const source = await readFile(new URL('../owner-operation-api.mjs', import.meta.url), 'utf8')
  assert.match(source, /executionGateEnabled\(env\)/)
  assert.match(source, /OWNER_ZERO_TRX_BURN_PREFLIGHT_BLOCKED/)
  assert.match(source, /TRAX_RUNTIME_BYTECODE_SHA256/)
  assert.match(source, /input\.signedTransaction/)
  assert.match(source, /verifySignedTransaction\(tronWeb, signed, ownerAddress\)/)
  assert.doesNotMatch(source, /signerFactory|signContractTransaction|createOwnerManagedSigner/)
  assert.match(source, /broadcastTransaction/)
  assert.match(source, /walletsolidity\/gettransactioninfobyid/)
})

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  return JSON.stringify(value)
}
function makeExecutionFixture(overrides = {}) {
  const intent = { ownerAddress: owner, contractAddress: contract, method: 'setPaused', args: [true], feeLimitSun: '1000000' }
  const intentSha256 = createHash('sha256').update('pause:' + canonical(intent)).digest('hex')
  const operation = {
    operation_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    session_id: 9, idempotency_key: 'owner-operation-test-00001',
    operation_type: 'pause', contract_address: contract, intent, intent_sha256: intentSha256,
    state: 'awaiting-confirmation', transaction_id: null,
    receipt: { unsignedTransaction: { txID: 'b'.repeat(64), raw_data_hex: 'ab'.repeat(32), raw_data: { expiration: Date.now() + 60_000 } } },
  }
  const transitions = []
  const reconciledTransactions = []
  const counts = { broadcast: 0, preflight: 0, verify: 0, signatureCheck: 0 }
  const ledger = {
    async get() { return { ...operation, state: transitions.at(-1)?.state || operation.state } },
    async claimConfirmation() { operation.state = 'confirming'; return { ...operation } },
    async transition(input) {
      if (input.nextState === 'signed' && overrides.persistSignedFailure) throw new Error('durable signed transaction write failed')
      transitions.push({ state: input.nextState, ...input })
      operation.state = input.nextState
      if (input.transactionId) operation.transaction_id = input.transactionId
      return { state: input.nextState }
    },
  }
  const api = createOwnerOperationApi({
    env: {
      DATABASE_URL: testDatabaseUrl, OWNER_ADMIN_EXPECTED_DATABASE_IDENTITY_SHA256: testDatabaseIdentity,
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
    ledgerFactory: () => overrides.ledger || ledger,
    tronWebFactory: () => ({ trx: {} }),
    verifyContractState: async () => { counts.verify++ },
    verifyUnsignedTransaction: async () => {},
    verifySignedTransaction: async () => { counts.signatureCheck++; if (overrides.signatureFailure) throw Object.assign(new Error('signature rejected'), { code: 'OWNER_SIGNED_TRANSACTION_PERMISSION_INVALID', status: 403 }) },
    prepareTransaction: async () => ({ txID: 'b'.repeat(64), raw_data_hex: 'ab'.repeat(32), raw_data: { expiration: Date.now() + 60_000 } }),
    preflightTransaction: async () => { counts.preflight++; if (overrides.preflightFailure) throw Object.assign(new Error('blocked'), { code: 'OWNER_ZERO_TRX_BURN_PREFLIGHT_BLOCKED', status: 423 }); return { estimatedTrxFallbackSun: '0' } },
    broadcastTransaction: async (_tronWeb, signed) => { counts.broadcast++; return { result: true, txid: signed.txID } },
    reconcileTransaction: async (_txId, _owner, _contract, options) => { reconciledTransactions.push(options.expectedTransaction); return { solidified: true, success: true, status: 'SUCCESS', blockNumber: 123 } },
  })
  const replies = []
  return { api, operation, intentSha256, transitions, counts, replies, reconciledTransactions, ledger }
}

test('Owner confirmation verifies the encrypted local Owner Wallet signature and durably journals before broadcast', async () => {
  const fixture = makeExecutionFixture()
  const req = request('POST', {
    confirmationPhrase: 'CONFIRM TRON MAINNET OWNER OPERATION',
    intentSha256: fixture.intentSha256,
    contractAddress: contract,
    signedTransaction: { txID: 'b'.repeat(64), raw_data_hex: 'ab'.repeat(32), raw_data: { expiration: Date.now() + 60_000 }, signature: ['a'.repeat(130)] },
  })
  await fixture.api.handle(req, response(), new URL('https://api.test/api/owner/operations/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11/confirm'), 'https://tron-transfer.onrender.com')
  assert.equal(fixture.replies[0].status, 200)
  assert.equal(fixture.replies[0].payload.state, 'confirmed')
  assert.equal(fixture.counts.broadcast, 1)
  assert.equal(fixture.counts.signatureCheck, 1)
  assert.equal(fixture.reconciledTransactions[0]?.txID, 'b'.repeat(64))
  assert.equal(fixture.reconciledTransactions[0]?.raw_data_hex, 'ab'.repeat(32))
  assert.deepEqual(fixture.transitions.map(item => item.state), ['signed', 'broadcast-unknown', 'broadcast', 'confirmed'])
})

test('Owner signed operation is reconciled after Resource API restart without signing or rebroadcasting', async () => {
  const beforeRestart = makeExecutionFixture()
  beforeRestart.operation.state = 'broadcast-unknown'
  beforeRestart.operation.transaction_id = 'b'.repeat(64)
  beforeRestart.operation.receipt.signedTransaction = {
    txID: 'b'.repeat(64), raw_data_hex: 'ab'.repeat(32),
    raw_data: { expiration: Date.now() + 60_000 }, signature: ['a'.repeat(130)],
  }
  const afterRestart = makeExecutionFixture({ ledger: beforeRestart.ledger })
  await afterRestart.api.handle(
    request('GET'),
    response(),
    new URL('https://api.test/api/owner/operations/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'),
    'https://tron-transfer.onrender.com',
  )
  assert.equal(afterRestart.replies[0].status, 200)
  assert.equal(afterRestart.replies[0].payload.operation.state, 'confirmed')
  assert.equal(afterRestart.replies[0].payload.reconciliation.solidified, true)
  assert.equal(afterRestart.counts.broadcast, 0)
  assert.equal(afterRestart.counts.signatureCheck, 0)
  assert.equal(afterRestart.reconciledTransactions.length, 1)
  assert.equal(beforeRestart.operation.state, 'confirmed')
})

test('Owner confirmation accepts full-size local Owner Wallet batch transaction payloads before execution gates', async () => {
  const fixture = makeExecutionFixture({ env: { OWNER_OPERATION_EXECUTION_ENABLED: 'false' } })
  await fixture.api.handle(request('POST', {
    confirmationPhrase: 'CONFIRM TRON MAINNET OWNER OPERATION',
    intentSha256: fixture.intentSha256,
    contractAddress: contract,
    signedTransaction: { txID: 'b'.repeat(64), raw_data_hex: 'ab'.repeat(32), raw_data: { expiration: Date.now() + 60_000 }, signature: ['a'.repeat(130)] },
    padding: 'x'.repeat(20_000),
  }), response(), new URL('https://api.test/api/owner/operations/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11/confirm'), 'https://tron-transfer.onrender.com')
  assert.equal(fixture.replies[0].status, 423)
  assert.equal(fixture.transitions.length, 0)
})

test('Owner confirmation refuses to sign or broadcast without the locally signed Owner transaction', async () => {
  const fixture = makeExecutionFixture()
  await fixture.api.handle(request('POST', {
    confirmationPhrase: 'CONFIRM TRON MAINNET OWNER OPERATION',
    intentSha256: fixture.intentSha256,
    contractAddress: contract,
  }), response(), new URL('https://api.test/api/owner/operations/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11/confirm'), 'https://tron-transfer.onrender.com')
  assert.equal(fixture.replies[0].status, 409)
  assert.equal(fixture.replies[0].payload.error, 'OWNER_SIGNED_TRANSACTION_MISMATCH')
  assert.equal(fixture.counts.signatureCheck, 0)
  assert.equal(fixture.counts.broadcast, 0)
})

test('Owner confirmation rejects a mismatched phrase or intent hash before claiming or signing', async () => {
  const fixture = makeExecutionFixture()
  await fixture.api.handle(request('POST', {
    confirmationPhrase: 'WRONG PHRASE', intentSha256: fixture.intentSha256, contractAddress: contract,
  }), response(), new URL('https://api.test/api/owner/operations/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11/confirm'), 'https://tron-transfer.onrender.com')
  assert.equal(fixture.replies[0].status, 400)
  assert.equal(fixture.counts.broadcast, 0)
  assert.equal(fixture.transitions.length, 0)
})

test('Owner confirmation fails closed on a fresh resource shortfall without signing or broadcast', async () => {
  const fixture = makeExecutionFixture({ preflightFailure: true })
  await fixture.api.handle(request('POST', {
    confirmationPhrase: 'CONFIRM TRON MAINNET OWNER OPERATION',
    intentSha256: fixture.intentSha256, contractAddress: contract,
    signedTransaction: { txID: 'b'.repeat(64), raw_data_hex: 'ab'.repeat(32), raw_data: { expiration: Date.now() + 60_000 }, signature: ['a'.repeat(130)] },
  }), response(), new URL('https://api.test/api/owner/operations/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11/confirm'), 'https://tron-transfer.onrender.com')
  assert.equal(fixture.replies[0].status, 423)
  assert.equal(fixture.counts.broadcast, 0)
  assert.equal(fixture.transitions.at(-1).state, 'failed')
})

test('Owner confirmation remains disabled without both explicit Mainnet execution gates', async () => {
  const fixture = makeExecutionFixture({ env: { OWNER_OPERATION_MAINNET_ACK: '' } })
  await fixture.api.handle(request('POST', {}), response(), new URL('https://api.test/api/owner/operations/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11/confirm'), 'https://tron-transfer.onrender.com')
  assert.equal(fixture.replies[0].status, 423)
  assert.equal(fixture.counts.broadcast, 0)
})

test('Owner confirmation never broadcasts if recovered signature or permission evidence fails', async () => {
  const fixture = makeExecutionFixture({ signatureFailure: true })
  await fixture.api.handle(request('POST', {
    confirmationPhrase: 'CONFIRM TRON MAINNET OWNER OPERATION',
    intentSha256: fixture.intentSha256, contractAddress: contract,
    signedTransaction: { txID: 'b'.repeat(64), raw_data_hex: 'ab'.repeat(32), raw_data: { expiration: Date.now() + 60_000 }, signature: ['a'.repeat(130)] },
  }), response(), new URL('https://api.test/api/owner/operations/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11/confirm'), 'https://tron-transfer.onrender.com')
  assert.equal(fixture.replies[0].status, 403)
  assert.equal(fixture.counts.signatureCheck, 1)
  assert.equal(fixture.counts.broadcast, 0)
  assert.equal(fixture.transitions.at(-1).state, 'failed')
})

test('Owner journal endpoint returns only Owner-identity-scoped intent and preflight summaries', async () => {
  const replies = []
  const api = createOwnerOperationApi({
    env: {
      DATABASE_URL: testDatabaseUrl, OWNER_ADMIN_EXPECTED_DATABASE_IDENTITY_SHA256: testDatabaseIdentity,
      TRON_OWNER_ADDRESS: owner,
      OWNER_OPERATION_LEDGER_DURABLE: 'true',
      OWNER_OPERATION_LEDGER_BACKUP_VERIFIED: 'true',
      OWNER_OPERATION_LEDGER_RESTORE_TESTED: 'true',
    },
    database: { async query() { return { rows: [{ operations_table: 'tron_transfer_owner_operations' }] } } },
    send: (_res, status, payload) => replies.push({ status, payload }),
    authenticateManagedSession: async () => ({ address: owner, sessionId: 9 }),
    ledgerFactory: () => ({ async list(_sessionId, limit) {
      assert.equal(limit, 5)
      return [{
        operation_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        operation_type: 'pause', contract_address: contract, state: 'awaiting-confirmation',
        intent_sha256: 'c'.repeat(64), intent: { method: 'setPaused', args: [true], feeLimitSun: '1000000' },
        preflight: { estimatedTrxFallbackSun: '0' }, transaction_id: null,
      }]
    } }),
  })
  await api.handle(request('GET'), response(), new URL('https://api.test/api/owner/operations?limit=5'), null)
  assert.equal(replies[0].status, 200)
  assert.equal(replies[0].payload.operations[0].method, 'setPaused')
  assert.equal(replies[0].payload.operations[0].preflight.estimatedTrxFallbackSun, '0')
  assert.equal(JSON.stringify(replies[0].payload).includes('signedTransaction'), false)
})

test('Owner operation API rate-limits repeated prepared writes per authenticated session', async () => {
  const replies = []
  const api = createOwnerOperationApi({
    env: {
      DATABASE_URL: testDatabaseUrl, OWNER_ADMIN_EXPECTED_DATABASE_IDENTITY_SHA256: testDatabaseIdentity,
      TRON_OWNER_ADDRESS: owner, TRAX_CONTRACT_ADDRESS: contract,
      OWNER_OPERATION_LEDGER_DURABLE: 'true',
      OWNER_OPERATION_LEDGER_BACKUP_VERIFIED: 'true',
      OWNER_OPERATION_LEDGER_RESTORE_TESTED: 'true',
    },
    database: { async query() { return { rows: [{ operations_table: 'tron_transfer_owner_operations' }] } } },
    send: (_res, status, payload) => replies.push({ status, payload }),
    authenticateManagedSession: async () => ({ address: owner, sessionId: 99 }),
  })
  for (let i = 0; i < 7; i++) {
    await api.handle(request('POST', {
      operationType: 'not-allowed', contractAddress: contract,
      idempotencyKey: 'owner-rate-limit-test-' + String(i).padStart(3, '0'),
      feeLimitSun: '1000000',
    }), response(), new URL('https://api.test/api/owner/operations/prepare'), null)
  }
  assert.equal(replies.slice(0, 6).every(reply => reply.status === 400), true, JSON.stringify(replies.map(reply => ({ status: reply.status, error: reply.payload?.error }))))
  assert.equal(replies[6].status, 429)
  assert.equal(replies[6].payload.error, 'OWNER_OPERATION_RATE_LIMITED')
})

test('Owner confirmation never broadcasts unless the signed transaction is durably persisted first', async () => {
  const fixture = makeExecutionFixture({ persistSignedFailure: true })
  await fixture.api.handle(request('POST', {
    confirmationPhrase: 'CONFIRM TRON MAINNET OWNER OPERATION',
    intentSha256: fixture.intentSha256, contractAddress: contract,
    signedTransaction: { txID: 'b'.repeat(64), raw_data_hex: 'ab'.repeat(32), raw_data: { expiration: Date.now() + 60_000 }, signature: ['a'.repeat(130)] },
  }), response(), new URL('https://api.test/api/owner/operations/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11/confirm'), 'https://tron-transfer.onrender.com')
  assert.equal(fixture.replies[0].status, 503)
  assert.equal(fixture.counts.broadcast, 0)
  assert.equal(fixture.transitions.at(-1).state, 'failed')
})
