import test from 'node:test'
import assert from 'node:assert/strict'
import { createOwnerAuthRouter } from '../server/routes/owner-auth.mjs'

const origin = 'https://localhost'
const setupKey = 'owner-setup-secret-for-tests-000000000000000000000000000000000000'
const token = 't'.repeat(43)
const testPassword = 'strong-owner-password-2026'

function responseRecorder() {
  let statusCode = 200
  let body = null
  const headers = {}
  return {
    status(code) { statusCode = code; return this },
    setHeader(name, value) { headers[name.toLowerCase()] = value; return this },
    json(value) { body = value; return this },
    get statusCode() { return statusCode },
    get body() { return body },
    headers,
  }
}

function routeHandler(router, path, method) {
  const layer = router.stack.find(item => item.route?.path === path && item.route.methods?.[method])
  assert.ok(layer, `${method.toUpperCase()} ${path} is registered`)
  return layer.route.stack[0].handle
}

function request({ body = {}, bearer = '', requestOrigin = origin } = {}) {
  return {
    body,
    headers: { authorization: bearer ? 'Bearer ' + bearer : '', origin: requestOrigin },
    get(name) { return this.headers[name.toLowerCase()] || '' },
  }
}

function makeRouter() {
  let account = null
  const sessions = new Map()
  const router = createOwnerAuthRouter({
    env: { OWNER_SETUP_KEY: setupKey, FRONTEND_ORIGIN: origin, PACKAGED_APP_ORIGINS: 'tronstudio://app' },
    getAccount: async () => ({ success: true, account: account ? { ...account } : null }),
    createAccount: async ({ email, passwordHash }) => {
      if (account) return { success: true, created: false }
      account = { email, passwordHash }
      return { success: true, created: true }
    },
    saveSession: async ({ tokenHash, email, origin: sessionOrigin, expiresAt }) => {
      sessions.set(tokenHash, { email, origin: sessionOrigin, expiresAt })
      return { success: true }
    },
    readSession: async ({ tokenHash, origin: sessionOrigin, nowMs }) => {
      const session = sessions.get(tokenHash)
      if (!session || session.origin !== sessionOrigin || session.expiresAt <= nowMs) return { success: true, session: null }
      return { success: true, session: { ...session } }
    },
    deleteSession: async ({ tokenHash }) => {
      sessions.delete(tokenHash)
      return { success: true }
    },
    randomToken: () => token,
    now: () => Date.parse('2026-10-28T00:00:00.000Z'),
  })
  return router
}

test('one-time setup needs an allowed Origin and a configured high-entropy setup key', async () => {
  const router = makeRouter()
  const handler = routeHandler(router, '/setup', 'post')
  const wrongOrigin = responseRecorder()
  await handler(request({ requestOrigin: 'https://attacker.example', body: { setupKey, email: 'owner@example.com', password: testPassword } }), wrongOrigin)
  assert.equal(wrongOrigin.statusCode, 403)
  assert.equal(wrongOrigin.body.error, 'origin-not-allowed')

  const wrongKey = responseRecorder()
  await handler(request({ body: { setupKey: 'wrong-key-that-is-long-enough-for-this-check-00000000000000', email: 'owner@example.com', password: testPassword } }), wrongKey)
  assert.equal(wrongKey.statusCode, 403)
  assert.equal(wrongKey.body.error, 'owner-setup-not-authorized')
})

test('owner setup creates exactly one account and never returns its password hash', async () => {
  const router = makeRouter()
  const handler = routeHandler(router, '/setup', 'post')
  const first = responseRecorder()
  await handler(request({ body: { setupKey, email: 'Owner@Example.com', password: testPassword } }), first)
  assert.equal(first.statusCode, 201)
  assert.equal(first.body.accountCreated, true)
  assert.equal(first.body.email, 'owner@example.com')
  assert.equal(Object.hasOwn(first.body, 'passwordHash'), false)

  const second = responseRecorder()
  await handler(request({ body: { setupKey, email: 'other@example.com', password: testPassword } }), second)
  assert.equal(second.statusCode, 409)
  assert.equal(second.body.error, 'owner-account-already-initialized')
})

test('owner login issues an opaque time-limited session and logout revokes it', async () => {
  const router = makeRouter()
  const setup = responseRecorder()
  await routeHandler(router, '/setup', 'post')(request({ body: { setupKey, email: 'owner@example.com', password: testPassword } }), setup)

  const login = responseRecorder()
  await routeHandler(router, '/login', 'post')(request({ body: { email: 'owner@example.com', password: testPassword } }), login)
  assert.equal(login.statusCode, 200)
  assert.equal(login.body.authenticated, true)
  assert.equal(login.body.email, 'owner@example.com')
  assert.equal(login.body.sessionToken, token)
  assert.ok(login.body.expiresAt > Date.parse('2026-10-28T00:00:00.000Z'))
  assert.equal(Object.hasOwn(login.body, 'passwordHash'), false)

  const session = responseRecorder()
  await routeHandler(router, '/session', 'get')(request({ bearer: token }), session)
  assert.equal(session.statusCode, 200)
  assert.equal(session.body.authenticated, true)
  assert.equal(session.body.email, 'owner@example.com')

  const logout = responseRecorder()
  await routeHandler(router, '/logout', 'post')(request({ bearer: token }), logout)
  assert.equal(logout.statusCode, 200)

  const afterLogout = responseRecorder()
  await routeHandler(router, '/session', 'get')(request({ bearer: token }), afterLogout)
  assert.equal(afterLogout.statusCode, 401)
  assert.equal(afterLogout.body.authenticated, false)
})

test('wrong owner credentials and origin-bound session cannot authenticate another origin', async () => {
  const router = makeRouter()
  await routeHandler(router, '/setup', 'post')(request({ body: { setupKey, email: 'owner@example.com', password: testPassword } }), responseRecorder())

  const login = responseRecorder()
  await routeHandler(router, '/login', 'post')(request({ body: { email: 'owner@example.com', password: 'incorrect-owner-password' } }), login)
  assert.equal(login.statusCode, 401)

  const crossOrigin = responseRecorder()
  await routeHandler(router, '/session', 'get')(request({ bearer: token, requestOrigin: 'https://another-origin.example' }), crossOrigin)
  assert.equal(crossOrigin.statusCode, 401)
})
