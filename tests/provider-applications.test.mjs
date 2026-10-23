import test from 'node:test'
import assert from 'node:assert/strict'
import router from '../server/routes/native-tron.mjs'
import {
  createSponsorProviderApplication,
  reviewSponsorProviderApplication,
} from '../server/database.mjs'

function getRoute(method, routePath) {
  const layer = router.stack.find((item) =>
    item.route?.path === routePath && item.route.methods?.[method],
  )
  assert.ok(layer, 'expected route to be registered: ' + method.toUpperCase() + ' ' + routePath)
  return layer.route.stack[0].handle
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; return this },
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

test('provider intake refuses unknown fields so secrets cannot be accepted accidentally', async () => {
  const res = responseRecorder()
  await getRoute('post', '/sponsorship/provider-applications')({
    body: {
      providerName: 'Example Sponsor',
      contactEmail: 'contact@example.com',
      scope: 'network-fees',
      privacyConsent: true,
      apiSecret: 'must-not-be-stored',
    },
    headers: {},
  }, res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.error, 'unexpected-fields')
  assert.equal(JSON.stringify(res.body).includes('must-not-be-stored'), false)
  assert.equal(res.headers['Cache-Control'], 'no-store')
})

test('provider intake requires explicit consent before storage', async () => {
  const res = responseRecorder()
  await getRoute('post', '/sponsorship/provider-applications')({
    body: {
      providerName: 'Example Sponsor',
      contactEmail: 'contact@example.com',
      scope: 'network-fees',
    },
    headers: {},
  }, res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.error, 'privacy-consent-required')
})

test('provider intake rejects invalid scopes before touching the database', async () => {
  const res = responseRecorder()
  await getRoute('post', '/sponsorship/provider-applications')({
    body: {
      providerName: 'Example Sponsor',
      contactEmail: 'contact@example.com',
      scope: 'wallet-drain',
      privacyConsent: true,
    },
    headers: {},
  }, res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.error, 'invalid-scope')
})

test('public application status lookup rejects malformed references before database access', async () => {
  const res = responseRecorder()
  await getRoute('get', '/sponsorship/provider-applications/:reference/status')({
    params: { reference: '../private' },
    query: {},
    headers: {},
  }, res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.error, 'invalid-application-reference')
})

test('provider contact list and review endpoints require the server-side admin token', async () => {
  const previous = process.env.SPONSOR_ADMIN_API_TOKEN
  process.env.SPONSOR_ADMIN_API_TOKEN = 'provider-application-test-admin-token-000000000000'
  try {
    const list = responseRecorder()
    await getRoute('get', '/sponsorship/provider-applications')({
      query: {}, headers: {},
    }, list)
    assert.equal(list.statusCode, 401)
    assert.equal(list.body.error, 'unauthorized')

    const review = responseRecorder()
    await getRoute('post', '/sponsorship/provider-applications/:reference/review')({
      params: { reference: '00000000-0000-4000-8000-000000000000' },
      body: { status: 'accepted-for-due-diligence', reviewReference: 'case-42' },
      headers: {},
    }, review)
    assert.equal(review.statusCode, 401)
    assert.equal(review.body.error, 'unauthorized')
  } finally {
    if (previous === undefined) delete process.env.SPONSOR_ADMIN_API_TOKEN
    else process.env.SPONSOR_ADMIN_API_TOKEN = previous
  }
})

test('database helpers reject invalid application identities and review transitions before database access', async () => {
  assert.deepEqual(await createSponsorProviderApplication({
    reference: 'invalid',
    providerName: 'Example Sponsor',
    contactEmail: 'contact@example.com',
    scope: 'network-fees',
  }), { success: false, reason: 'invalid-provider-application' })
  assert.deepEqual(await reviewSponsorProviderApplication({
    reference: 'invalid',
    status: 'accepted-for-due-diligence',
    reviewReference: 'case-42',
  }), { success: false, reason: 'invalid-review' })
})
