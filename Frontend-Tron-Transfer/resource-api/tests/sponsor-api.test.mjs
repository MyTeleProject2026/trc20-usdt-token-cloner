import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createSponsorResourceApi } from '../sponsor-api.mjs'

const SPONSOR = 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL'
const OWNER = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const SECRET = 'test-session-secret-with-at-least-thirty-two-bytes'
const SIGNATURE = 'a'.repeat(130)

function request(method, path, body, token) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  stream.method = method
  stream.url = path
  stream.headers = { ...(token ? { authorization: 'Bearer ' + token } : {}) }
  stream.socket = { remoteAddress: '127.0.0.1' }
  return stream
}
function response() {
  return { status: 0, payload: null }
}
function setup({ database = null, engine = null } = {}) {
  const env = {
    SPONSOR_SESSION_SECRET: SECRET,
    SPONSOR_MAINNET_ADDRESS: SPONSOR,
    TRON_OWNER_ADDRESS: OWNER,
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
async function call(api, method, path, body, token) {
  const res = response()
  const handled = await api.handle(request(method, path, body, token), res, new URL(path, 'http://localhost'), null)
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

test('Sponsor status exposes readiness but never secret values', async () => {
  const { api } = setup()
  const result = await call(api, 'GET', '/api/sponsor/status')
  assert.equal(result.status, 200)
  assert.equal(result.payload.network, 'TRON Mainnet')
  assert.equal(result.payload.sponsorAddress, SPONSOR)
  assert.equal(result.payload.transactionExecutionAvailable, false)
  assert.equal(JSON.stringify(result.payload).includes(SECRET), false)
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
      if (sql.trimStart().startsWith('CREATE TABLE') || sql.trimStart().startsWith('CREATE INDEX')) return { rowCount: 0, rows: [] }
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
