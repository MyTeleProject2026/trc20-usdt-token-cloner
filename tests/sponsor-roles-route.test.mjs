import test from 'node:test'
import assert from 'node:assert/strict'
import nativeTronRoutes from '../server/routes/native-tron.mjs'

const layer = nativeTronRoutes.stack.find((item) =>
  item.route?.path === '/sponsorship/roles' && item.route.methods?.get,
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

test('independent sponsor roles route is mounted and rejects unsupported networks', async () => {
  assert.ok(layer, 'GET /sponsorship/roles must be registered')
  const response = makeResponse()
  await layer.route.stack[0].handle({ query: { network: 'sideways' } }, response)
  assert.equal(response.statusCode, 400)
  assert.equal(response.body.error, 'invalid-network')
  assert.equal(response.body.canSubmitSponsoredTransfer, undefined)
})

test('independent sponsor roles route rejects malformed refresh values', async () => {
  assert.ok(layer)
  const response = makeResponse()
  await layer.route.stack[0].handle({ query: { network: 'nile', refresh: 'yes' } }, response)
  assert.equal(response.statusCode, 400)
  assert.equal(response.body.error, 'invalid-refresh')
})

test('independent sponsor roles route returns distinct fail-closed roles when addresses are not configured', async () => {
  assert.ok(layer)
  const response = makeResponse()
  await layer.route.stack[0].handle({ query: { network: 'nile' } }, response)
  assert.equal(response.statusCode, 200)
  assert.equal(response.body.success, true)
  assert.equal(response.body.status, 'read-only-sponsor-roles')
  assert.equal(response.body.network, 'nile')
  assert.equal(response.body.roles.networkFeeSponsor.role, 'network-fee-sponsor')
  assert.equal(response.body.roles.assetPrincipalSponsor.role, 'asset-principal-sponsor')
  assert.equal(response.body.roles.networkFeeSponsor.status, 'sponsor-address-not-configured')
  assert.equal(response.body.roles.assetPrincipalSponsor.status, 'sponsor-address-not-configured')
  assert.equal(response.body.roles.networkFeeSponsor.canSubmitSponsoredTransfer, false)
  assert.equal(response.body.roles.assetPrincipalSponsor.canSubmitSponsoredTransfer, false)
  assert.equal(response.body.canSubmitSponsoredTransfer, false)
  assert.equal(response.body.submissionEnabled, false)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(response.headers.pragma, 'no-cache')
  assert.ok(response.body.limitations.some((item) => item.includes('No user-funded fallback is permitted')))
})
