import test from 'node:test'
import assert from 'node:assert/strict'
import { requestSponsorReconciliation } from '../scripts/reconcile-sponsor-transfer.mjs'

const token = 'server-admin-token-for-script-test-0123456789'
const key = 'operator-created-sponsor-transfer-key-0001'

test('reconciliation cli requires a long server-admin token and a valid key', async () => {
  assert.equal((await requestSponsorReconciliation({ adminToken: 'short', idempotencyKey: key })).error, 'SPONSOR_ADMIN_API_TOKEN-missing-or-too-short')
  assert.equal((await requestSponsorReconciliation({ adminToken: token, idempotencyKey: 'short' })).error, 'invalid-idempotency-key')
})

test('reconciliation cli rejects insecure or credential-bearing remote API URLs', async () => {
  for (const apiBaseUrl of [
    'http://example.com', 'https://user:pass@example.com', 'https://example.com/?x=1',
    'javascript:alert(1)', 'not-a-url',
  ]) {
    const result = await requestSponsorReconciliation({ apiBaseUrl, adminToken: token, idempotencyKey: key })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'invalid-api-base-url')
  }
})

test('reconciliation cli posts only an empty request body to the exact stored-transfer route', async () => {
  let called
  const result = await requestSponsorReconciliation({
    apiBaseUrl: 'https://example.test/base/',
    adminToken: token,
    idempotencyKey: key,
    fetchImpl: async (url, init) => {
      called = { url, init }
      return { ok: true, status: 200, json: async () => ({
        success: true, status: 'solidified-transfer-ledger-confirmed', network: 'nile',
        transactionHash: 'a'.repeat(64), blockNumber: 123,
        principalLedger: { status: 'confirmed' },
        feeSponsorBudgetSettled: false, userFundedFallbackAllowed: false,
      }) }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(called.url, 'https://example.test/base/api/tron/sponsorship/transfers/' + key + '/reconcile-solidified')
  assert.equal(called.init.method, 'POST')
  assert.equal(called.init.redirect, 'error')
  assert.equal(called.init.body, '{}')
  assert.equal(called.init.headers.authorization, 'Bearer ' + token)
})

test('reconciliation cli never returns a token in request failure or response payload', async () => {
  const result = await requestSponsorReconciliation({
    apiBaseUrl: 'https://example.test',
    adminToken: token,
    idempotencyKey: key,
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ success: false, error: 'unauthorized', tokenEcho: token }) }),
  })
  assert.equal(result.ok, false)
  assert.equal(JSON.stringify({ ok: result.ok, error: result.error, httpStatus: result.httpStatus }).includes(token), false)
})

test('reconciliation cli does not follow redirects or expose provider exceptions', async () => {
  const result = await requestSponsorReconciliation({
    apiBaseUrl: 'https://example.test', adminToken: token, idempotencyKey: key,
    fetchImpl: async (_url, init) => {
      assert.equal(init.redirect, 'error')
      throw new Error('failure with ' + token)
    },
  })
  assert.deepEqual(result, { ok: false, error: 'reconciliation-request-failed' })
})
