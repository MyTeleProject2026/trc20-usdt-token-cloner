import test from 'node:test'
import assert from 'node:assert/strict'
import { createRippleWalletApiClient } from '../server/ripple-wallet-api-client.mjs'

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

test('Ripple Wallet client exchanges client credentials and caches its bearer token', async () => {
  let calls = 0
  const requests = []
  const client = createRippleWalletApiClient({
    env: {
      RIPPLE_WALLET_API_BASE_URL: 'https://api.sandbox.palisade.co',
      RIPPLE_WALLET_CLIENT_ID: 'sandbox-client-id',
      RIPPLE_WALLET_CLIENT_SECRET: 'sandbox-client-secret',
    },
    now: () => 1_000_000,
    fetchImpl: async (url, options) => {
      calls += 1
      requests.push({ url, options })
      if (url.endsWith('/v2/credentials/oauth/token')) {
        return response(200, { accessToken: 'sandbox-access-token-123456789', expiresIn: 3600 })
      }
      return response(200, { status: 'ok' })
    },
  })

  const result = await client.request('/v2/vaults')
  assert.deepEqual(result, { status: 'ok' })
  assert.equal(calls, 2)
  assert.equal(requests[0].options.method, 'POST')
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    clientId: 'sandbox-client-id',
    clientSecret: 'sandbox-client-secret',
  })
  assert.equal(requests[1].options.headers.authorization, 'Bearer sandbox-access-token-123456789')
  await client.request('/v2/vaults')
  assert.equal(calls, 3)
})

test('Ripple Wallet client rejects unknown API origins and unsafe paths', async () => {
  assert.throws(() => createRippleWalletApiClient({
    env: {
      RIPPLE_WALLET_API_BASE_URL: 'https://attacker.example',
      RIPPLE_WALLET_CLIENT_ID: 'x',
      RIPPLE_WALLET_CLIENT_SECRET: 'y',
    },
    fetchImpl: async () => response(200, {}),
  }), { code: 'ripple-api-base-url-not-allowlisted' })

  const client = createRippleWalletApiClient({
    env: {
      RIPPLE_WALLET_API_BASE_URL: 'https://api.sandbox.palisade.co',
      RIPPLE_WALLET_CLIENT_ID: 'x',
      RIPPLE_WALLET_CLIENT_SECRET: 'y',
    },
    fetchImpl: async () => response(200, { accessToken: 'sandbox-access-token-123456789', expiresIn: 3600 }),
  })
  await assert.rejects(client.request('/v2/../admin'), { code: 'ripple-api-path-invalid' })
})

test('Ripple Wallet client does not accept malformed or expired token responses', async () => {
  const client = createRippleWalletApiClient({
    env: {
      RIPPLE_WALLET_API_BASE_URL: 'https://api.sandbox.palisade.co',
      RIPPLE_WALLET_CLIENT_ID: 'x',
      RIPPLE_WALLET_CLIENT_SECRET: 'y',
    },
    fetchImpl: async () => response(200, { accessToken: 'short', expiresIn: 10 }),
  })
  await assert.rejects(client.getAccessToken(), { code: 'ripple-api-token-response-invalid' })
})

test('Ripple Wallet client requires server-side credentials and sanitizes provider errors', async () => {
  const missing = createRippleWalletApiClient({
    env: { RIPPLE_WALLET_API_BASE_URL: 'https://api.sandbox.palisade.co' },
    fetchImpl: async () => response(200, {}),
  })
  await assert.rejects(missing.getAccessToken(), { code: 'ripple-api-credentials-missing' })

  const failing = createRippleWalletApiClient({
    env: {
      RIPPLE_WALLET_API_BASE_URL: 'https://api.sandbox.palisade.co',
      RIPPLE_WALLET_CLIENT_ID: 'x',
      RIPPLE_WALLET_CLIENT_SECRET: 'y',
    },
    fetchImpl: async () => response(403, { message: 'sensitive provider detail' }),
  })
  await assert.rejects(failing.getAccessToken(), (error) => {
    assert.equal(error.code, 'ripple-api-http-error')
    assert.equal(error.status, 403)
    assert.equal(error.message, 'Ripple Wallet API request failed')
    return true
  })
})
