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
