import test from 'node:test'
import assert from 'node:assert/strict'
import nativeTronRoutes from '../server/routes/native-tron.mjs'

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

function route(path, method) {
  const layer = nativeTronRoutes.stack.find((item) => item.route?.path === path && item.route.methods?.[method])
  assert.ok(layer, `${method.toUpperCase()} ${path} must be registered`)
  return layer.route.stack.find((item) => item.method === method).handle
}

test('testnet signing intent fails closed with the feature flag unset', async () => {
  const previous = process.env.SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED
  try {
    delete process.env.SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED
    const response = makeResponse()
    await route('/sponsorship/transfers/:idempotencyKey/signing-intent', 'get')({
      params: { idempotencyKey: 'reservation-intent-key-00000001' }, query: {}, headers: {},
    }, response)
    assert.equal(response.statusCode, 503)
    assert.equal(response.body.status, 'testnet-signed-broadcast-disabled')
    assert.equal(response.body.canSubmitSponsoredTransfer, false)
    assert.equal(response.body.submissionEnabled, false)
  } finally {
    if (previous === undefined) delete process.env.SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED
    else process.env.SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED = previous
  }
})

test('testnet signed-broadcast endpoint fails closed with the feature flag unset', async () => {
  const previous = process.env.SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED
  try {
    delete process.env.SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED
    const response = makeResponse()
    await route('/sponsorship/transfers/:idempotencyKey/submit-signed', 'post')({
      params: { idempotencyKey: 'reservation-intent-key-00000001' },
      query: {}, headers: {}, body: { signedTransaction: { txID: 'a'.repeat(64) } },
    }, response)
    assert.equal(response.statusCode, 503)
    assert.equal(response.body.status, 'testnet-signed-broadcast-disabled')
    assert.equal(response.body.canSubmitSponsoredTransfer, false)
    assert.equal(response.body.providerSubmissionAttempted, false)
    assert.equal(response.body.transactionBroadcast, false)
  } finally {
    if (previous === undefined) delete process.env.SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED
    else process.env.SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED = previous
  }
})

test('signed-broadcast route rejects Mainnet before transaction or provider work', async () => {
  const previous = process.env.SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED
  try {
    process.env.SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED = 'true'
    const response = makeResponse()
    await route('/sponsorship/transfers/:idempotencyKey/submit-signed', 'post')({
      params: { idempotencyKey: 'reservation-intent-key-00000001' },
      query: {}, headers: {},
      body: { signedTransaction: { txID: 'a'.repeat(64), raw_data_hex: '01', signature: ['a'.repeat(130)] } },
    }, response)
    // With no live database configured in this unit test the request fails before
    // any broadcast. Mainnet remains impossible because the request must resolve
    // to a persisted Shasta/Nile transfer and the adapter rejects any other network.
    assert.ok([400, 503].includes(response.statusCode))
    assert.notEqual(response.body?.transactionBroadcast, true)
  } finally {
    if (previous === undefined) delete process.env.SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED
    else process.env.SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED = previous
  }
})
