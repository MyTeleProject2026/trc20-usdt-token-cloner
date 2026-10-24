import test from 'node:test'
import assert from 'node:assert/strict'
import nativeTronRoutes from '../server/routes/native-tron.mjs'
import { readFile } from 'node:fs/promises'

const layer = nativeTronRoutes.stack.find((item) =>
  item.route?.path === '/sponsorship/transfers/reserve' && item.route.methods?.post,
)
const adminToken = 'test-admin-token-that-is-at-least-32-characters-long'

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

async function callReservation(req) {
  const response = makeResponse()
  await layer.route.stack[0].handle(req, response)
  return response
}

test('operator-only reservation endpoint is registered and never claims to broadcast', async () => {
  assert.ok(layer, 'POST /sponsorship/transfers/reserve must be registered')
  const source = await readFile(new URL('../server/routes/native-tron.mjs', import.meta.url), 'utf8')
  assert.ok(source.includes('reserveSponsorTransfer({'))
  assert.ok(source.includes('fundingSnapshotReader: async (network) =>'))
  assert.ok(source.includes('roleResult.fundingSnapshots?.[roleName]'))
  assert.ok(source.includes('providerSubmissionAttempted: false'))
  assert.ok(source.includes('transactionBroadcast: false'))
  assert.ok(source.includes('unpaidFallbackToUserFunds: false'))
})

test('reservation route fails closed when the server-only administrator token is not configured', async () => {
  assert.ok(layer)
  const previous = process.env.SPONSOR_ADMIN_API_TOKEN
  try {
    delete process.env.SPONSOR_ADMIN_API_TOKEN
    const response = await callReservation({ body: {}, headers: {} })
    assert.equal(response.statusCode, 503)
    assert.equal(response.body.error, 'sponsor-admin-not-configured')
    assert.equal(response.body.canSubmitSponsoredTransfer, false)
    assert.equal(response.headers['cache-control'], 'no-store')
  } finally {
    if (previous === undefined) delete process.env.SPONSOR_ADMIN_API_TOKEN
    else process.env.SPONSOR_ADMIN_API_TOKEN = previous
  }
})

test('reservation route rejects callers without the administrator bearer token', async () => {
  assert.ok(layer)
  const previous = process.env.SPONSOR_ADMIN_API_TOKEN
  try {
    process.env.SPONSOR_ADMIN_API_TOKEN = adminToken
    const response = await callReservation({
      body: { network: 'nile' },
      headers: { authorization: 'Bearer incorrect-test-token' },
    })
    assert.equal(response.statusCode, 401)
    assert.equal(response.body.error, 'unauthorized')
    assert.equal(response.body.canSubmitSponsoredTransfer, false)
  } finally {
    if (previous === undefined) delete process.env.SPONSOR_ADMIN_API_TOKEN
    else process.env.SPONSOR_ADMIN_API_TOKEN = previous
  }
})

test('reservation route rejects Mainnet requests before any sponsor or database work', async () => {
  assert.ok(layer)
  const previous = process.env.SPONSOR_ADMIN_API_TOKEN
  try {
    process.env.SPONSOR_ADMIN_API_TOKEN = adminToken
    const response = await callReservation({
      body: { network: 'mainnet' },
      headers: { authorization: `Bearer ${adminToken}` },
    })
    assert.equal(response.statusCode, 400)
    assert.equal(response.body.error, 'testnet-only-reservation')
    assert.equal(response.body.canSubmitSponsoredTransfer, false)
  } finally {
    if (previous === undefined) delete process.env.SPONSOR_ADMIN_API_TOKEN
    else process.env.SPONSOR_ADMIN_API_TOKEN = previous
  }
})

test('reservation route rejects unexpected fields and signing material', async () => {
  assert.ok(layer)
  const previous = process.env.SPONSOR_ADMIN_API_TOKEN
  try {
    process.env.SPONSOR_ADMIN_API_TOKEN = adminToken
    const response = await callReservation({
      body: { network: 'nile', privateKey: 'never-accept-this' },
      headers: { authorization: `Bearer ${adminToken}` },
    })
    assert.equal(response.statusCode, 400)
    assert.equal(response.body.error, 'unexpected-fields')
    assert.equal(response.body.canSubmitSponsoredTransfer, false)
  } finally {
    if (previous === undefined) delete process.env.SPONSOR_ADMIN_API_TOKEN
    else process.env.SPONSOR_ADMIN_API_TOKEN = previous
  }
})

test('reservation route validates intent shape and blocks incompatible fee assets', async () => {
  assert.ok(layer)
  const previous = process.env.SPONSOR_ADMIN_API_TOKEN
  try {
    process.env.SPONSOR_ADMIN_API_TOKEN = adminToken
    const base = {
      idempotencyKey: 'reservation-test-0001',
      network: 'nile',
      sponsorReference: 'test-sponsor',
      purpose: 'network-fee',
      asset: 'USDT',
      tokenContract: 'T' + 'B'.repeat(33),
      receiverAddress: 'T' + 'A'.repeat(33),
      amountBaseUnits: '1000000',
    }
    const response = await callReservation({
      body: base,
      headers: { authorization: `Bearer ${adminToken}` },
    })
    assert.equal(response.statusCode, 400)
    assert.equal(response.body.error, 'invalid-transfer-intent')
    assert.equal(response.body.canSubmitSponsoredTransfer, false)
  } finally {
    if (previous === undefined) delete process.env.SPONSOR_ADMIN_API_TOKEN
    else process.env.SPONSOR_ADMIN_API_TOKEN = previous
  }
})
