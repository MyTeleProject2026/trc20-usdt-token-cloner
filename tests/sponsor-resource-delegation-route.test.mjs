import test from 'node:test'
import assert from 'node:assert/strict'
import nativeTronRoutes from '../server/routes/native-tron.mjs'

const layer = nativeTronRoutes.stack.find((item) =>
  item.route?.path === '/sponsorship/resource-delegations/verify' && item.route.methods?.post,
)

function makeResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this },
  }
}

const sponsorAddress = 'T' + 'A'.repeat(33)
const otherSponsorAddress = 'T' + 'C'.repeat(33)
const receiverAddress = 'T' + 'B'.repeat(33)
const requestBody = {
  network: 'shasta',
  transactionId: 'a'.repeat(64),
  sponsorAddress,
  receiverAddress,
  resourceType: 'ENERGY',
  stakeEquivalentSun: '10000000',
}

test('resource-delegation verification route is registered and fails closed without configured fee sponsor', async () => {
  assert.ok(layer, 'POST /sponsorship/resource-delegations/verify must be registered')
  const previous = process.env.SPONSOR_FEE_SHASTA_ADDRESS
  const previousTatumKey = process.env.TATUM_API_KEY
  try {
    delete process.env.SPONSOR_FEE_SHASTA_ADDRESS
    delete process.env.TATUM_API_KEY
    const response = makeResponse()
    await layer.route.stack[0].handle({ body: requestBody, headers: {} }, response)
    assert.equal(response.statusCode, 503)
    assert.equal(response.body.error, 'fee-sponsor-address-not-configured')
    assert.deepEqual(response.body.requiredEnvironment, ['SPONSOR_FEE_SHASTA_ADDRESS'])
    assert.equal(response.body.verified, false)
    assert.equal(response.body.persistence.persisted, false)
    assert.equal(response.headers['cache-control'], 'no-store')
  } finally {
    if (previous === undefined) delete process.env.SPONSOR_FEE_SHASTA_ADDRESS
    else process.env.SPONSOR_FEE_SHASTA_ADDRESS = previous
    if (previousTatumKey === undefined) delete process.env.TATUM_API_KEY
    else process.env.TATUM_API_KEY = previousTatumKey
  }
})

test('resource-delegation verification route rejects a caller-supplied sponsor that differs from the configured fee sponsor', async () => {
  assert.ok(layer)
  const previous = process.env.SPONSOR_FEE_SHASTA_ADDRESS
  const previousTatumKey = process.env.TATUM_API_KEY
  try {
    process.env.SPONSOR_FEE_SHASTA_ADDRESS = otherSponsorAddress
    delete process.env.TATUM_API_KEY
    const response = makeResponse()
    await layer.route.stack[0].handle({ body: requestBody, headers: {} }, response)
    assert.equal(response.statusCode, 403)
    assert.equal(response.body.error, 'sponsor-address-not-authorized')
    assert.equal(response.body.verified, false)
    assert.equal(response.body.persistence.persisted, false)
  } finally {
    if (previous === undefined) delete process.env.SPONSOR_FEE_SHASTA_ADDRESS
    else process.env.SPONSOR_FEE_SHASTA_ADDRESS = previous
    if (previousTatumKey === undefined) delete process.env.TATUM_API_KEY
    else process.env.TATUM_API_KEY = previousTatumKey
  }
})

test('resource-delegation verification still validates the request shape before authorization', async () => {
  assert.ok(layer)
  const response = makeResponse()
  await layer.route.stack[0].handle({
    body: { ...requestBody, unexpected: 'must-be-rejected' },
    headers: {},
  }, response)
  assert.equal(response.statusCode, 400)
  assert.equal(response.body.error, 'unexpected-fields')
})
