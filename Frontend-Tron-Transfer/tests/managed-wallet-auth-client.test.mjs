import test from 'node:test'
import assert from 'node:assert/strict'
import { createManagedWalletAuthClient } from '../src/managed-wallet-auth-client.mjs'

function response(status, payload) {
  return { ok: status >= 200 && status < 300, status, async json() { return payload } }
}

test('Owner and Sponsor clients use isolated route namespaces and cookie sessions', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    return response(200, { success: true, role: url.includes('/owner/') ? 'owner' : 'sponsor', address: 'T' + '1'.repeat(33) })
  }
  const owner = createManagedWalletAuthClient({ role: 'owner', apiBaseUrl: 'https://api.test/', fetchImpl })
  const sponsor = createManagedWalletAuthClient({ role: 'sponsor', apiBaseUrl: 'https://api.test', fetchImpl })
  await owner.session()
  await sponsor.session()
  assert.ok(calls[0].url.endsWith('/api/wallet-auth/owner/session'))
  assert.ok(calls[1].url.endsWith('/api/wallet-auth/sponsor/session'))
  for (const call of calls) {
    assert.equal(call.options.credentials, 'include')
    assert.equal(call.options.cache, 'no-store')
  }
})

test('enrollment token is sent only in the role-specific header, never the body or URL', async () => {
  let call
  const api = createManagedWalletAuthClient({ role: 'owner', apiBaseUrl: 'https://api.test', fetchImpl: async (url, options) => {
    call = { url, options }
    return response(201, { success: true, role: 'owner', session: { csrfToken: 'csrf-value' } })
  } })
  await api.enroll('a sufficiently long password', 'one-time-enrollment-secret')
  assert.equal(call.options.headers['x-owner-enrollment-token'], 'one-time-enrollment-secret')
  assert.equal(call.options.body, JSON.stringify({ password: 'a sufficiently long password' }))
  assert.equal(call.url.includes('one-time-enrollment-secret'), false)
})

test('logout sends CSRF proof and clears the in-memory token', async () => {
  const calls = []
  const api = createManagedWalletAuthClient({ role: 'sponsor', apiBaseUrl: 'https://api.test', fetchImpl: async (url, options) => {
    calls.push(options)
    if (url.endsWith('/login')) return response(200, { success: true, role: 'sponsor', session: { csrfToken: 'csrf-session' } })
    return response(200, { success: true, loggedOut: true })
  } })
  await api.login('a sufficiently long password')
  await api.logout()
  assert.equal(calls[1].headers['x-csrf-token'], 'csrf-session')
})

test('authenticated Resource API requests carry the role cookie, CSRF proof, and reject auth namespace escape', async () => {
  const calls = []
  const api = createManagedWalletAuthClient({
    role: 'sponsor',
    apiBaseUrl: 'https://api.test',
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      if (url.endsWith('/login')) return response(200, { success: true, role: 'sponsor', session: { csrfToken: 'sponsor-csrf' } })
      return response(200, { success: true })
    },
  })
  await api.login('a sufficiently long password')
  await api.apiRequest('/api/sponsor/intent', {
    method: 'POST', csrf: true, body: { operation: 'delegate' },
    headers: { 'x-sponsor-admin-token': 'admin-token-test-value' },
  })
  assert.equal(calls[1].url, 'https://api.test/api/sponsor/intent')
  assert.equal(calls[1].options.credentials, 'include')
  assert.equal(calls[1].options.headers['x-csrf-token'], 'sponsor-csrf')
  assert.equal(calls[1].options.headers['x-sponsor-admin-token'], 'admin-token-test-value')
  await assert.rejects(api.apiRequest('/api/wallet-auth/owner/session'), /MANAGED_WALLET_API_PATH_INVALID/)
})

test('client rejects invalid roles and does not persist secrets in browser storage', async () => {
  assert.throws(() => createManagedWalletAuthClient({ role: 'admin' }), /wallet-auth-role-invalid/)
  const api = createManagedWalletAuthClient({ role: 'owner', fetchImpl: async () => response(200, { success: true, enrolled: false }) })
  await api.status()
  assert.equal('localStorage' in globalThis, false)
})

test('server errors preserve safe error codes and HTTP status', async () => {
  const api = createManagedWalletAuthClient({ role: 'owner', fetchImpl: async () => response(401, { success: false, error: 'INVALID_CREDENTIALS_OR_LOCKED' }) })
  await assert.rejects(api.login('incorrect password'), error => error.status === 401 && error.code === 'INVALID_CREDENTIALS_OR_LOCKED')
})

test('session refresh restores a CSRF proof after a page reload before logout', async () => {
  const calls = []
  const api = createManagedWalletAuthClient({
    role: 'owner',
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      if (url.endsWith('/session')) return response(200, { success: true, role: 'owner', csrfToken: 'rotated-csrf' })
      return response(200, { success: true, loggedOut: true })
    },
  })
  await api.session()
  await api.logout()
  assert.equal(calls[1].options.headers['x-csrf-token'], 'rotated-csrf')
})
