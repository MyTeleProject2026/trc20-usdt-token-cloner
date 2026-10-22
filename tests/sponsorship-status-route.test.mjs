import test from 'node:test'
import assert from 'node:assert/strict'
import nativeTronRoutes from '../server/routes/native-tron.mjs'

test('sponsorship status endpoint is read-only and fails closed', async () => {
  const layer = nativeTronRoutes.stack.find((item) =>
    item.route?.path === '/sponsorship/status' && item.route.methods?.get,
  )
  assert.ok(layer, 'GET /sponsorship/status route must be registered')

  let statusCode = 200
  let responseBody
  const response = {
    status(code) { statusCode = code; return this },
    json(body) { responseBody = body; return this },
  }
  await layer.route.stack[0].handle({}, response)

  assert.equal(statusCode, 200)
  assert.equal(responseBody.success, true)
  assert.equal(responseBody.sponsorship.enabled, false)
  assert.equal(responseBody.sponsorship.mainnetEnabled, false)
  assert.equal(responseBody.sponsorship.canSubmitSponsoredTransfer, false)
  assert.equal(responseBody.sponsorship.provider, null)
  assert.ok(responseBody.sponsorship.requiredBeforeEnablement.includes('provider-specific-signing-authorization'))
  assert.ok(responseBody.sponsorship.requiredBeforeEnablement.includes('finalized-on-chain-evidence-and-idempotent-ledger-transitions'))
  assert.ok(responseBody.limitations.some((item) => item.includes('never authorizes or submits a transfer')))
})
