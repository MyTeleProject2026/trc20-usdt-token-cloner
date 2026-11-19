import test from 'node:test'
import assert from 'node:assert/strict'
import nativeTronRoutes from '../server/routes/native-tron.mjs'

const layer = nativeTronRoutes.stack.find((item) =>
  item.route?.path === '/sponsorship/resource-delegations/verify-wallet' && item.route.methods?.post,
)

function response() {
  return {
    statusCode: 200, body: null, headers: {},
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this },
  }
}

test('self-custody Sponsor Wallet verifier is registered and accepts only public Mainnet transaction details', async () => {
  assert.ok(layer, 'POST /sponsorship/resource-delegations/verify-wallet must be registered')
  const res = response()
  await layer.route.stack[0].handle({
    ip: 'sponsor-wallet-test-invalid-shape',
    body: {
      network: 'shasta',
      transactionId: 'a'.repeat(64),
      sponsorAddress: 'T' + 'A'.repeat(33),
      receiverAddress: 'T' + 'B'.repeat(33),
      resourceType: 'ENERGY',
      stakeEquivalentSun: '1000000',
    },
  }, res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.error, 'invalid-delegation-details')
  assert.equal(res.body.verified, false)
  assert.equal(res.headers['cache-control'], 'no-store')
})

test('self-custody Sponsor Wallet verifier rejects wallet secrets and unexpected payload fields', async () => {
  assert.ok(layer)
  const res = response()
  await layer.route.stack[0].handle({
    ip: 'sponsor-wallet-test-secret-field',
    body: {
      network: 'mainnet',
      transactionId: 'a'.repeat(64),
      sponsorAddress: 'T' + 'A'.repeat(33),
      receiverAddress: 'T' + 'B'.repeat(33),
      resourceType: 'ENERGY',
      stakeEquivalentSun: '1000000',
      privateKey: 'must-never-be-accepted',
    },
  }, res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.error, 'unexpected-fields')
  assert.equal(res.body.verified, false)
})

test('self-custody Sponsor Wallet verifier applies a per-IP request limit', async () => {
  assert.ok(layer)
  const ip = 'sponsor-wallet-test-rate-limit'
  const request = { ip, body: {} }
  for (let i = 0; i < 12; i++) {
    const res = response()
    await layer.route.stack[0].handle(request, res)
    assert.notEqual(res.statusCode, 429)
  }
  const limited = response()
  await layer.route.stack[0].handle(request, limited)
  assert.equal(limited.statusCode, 429)
  assert.equal(limited.body.error, 'verification-rate-limited')
})
