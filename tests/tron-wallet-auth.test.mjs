import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createTronWalletAuthRouter } from '../server/routes/tron-wallet-auth.mjs'

const origin = 'https://trc20-usdt-token-cloner.onrender.com'
const address = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'
const otherAddress = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const signature = '0x' + 'a'.repeat(130)

function createMemoryAuthStore() {
  const challenges = new Map()
  const sessions = new Map()
  const accounts = new Set()
  return {
    challenges,
    sessions,
    accounts,
    async createChallenge({ nonceHash, address, network, origin, message, expiresAt }) {
      if (challenges.has(nonceHash)) return { success: false, reason: 'duplicate' }
      challenges.set(nonceHash, { address, network, origin, message, expiresAt })
      return { success: true }
    },
    async consumeChallenge({ nonceHash }) {
      const challenge = challenges.get(nonceHash) ?? null
      challenges.delete(nonceHash)
      return { success: true, challenge }
    },
    async createSession({ tokenHash, address, network, origin, expiresAt }) {
      sessions.set(tokenHash, { address, network, origin, expiresAt })
      accounts.add(network + ':' + address)
      return { success: true }
    },
    async getSession({ tokenHash, origin, nowMs }) {
      const session = sessions.get(tokenHash)
      if (!session || session.origin !== origin || session.expiresAt <= nowMs) {
        if (session?.expiresAt <= nowMs) sessions.delete(tokenHash)
        return { success: true, session: null }
      }
      return { success: true, session }
    },
    async revokeSession({ tokenHash }) {
      sessions.delete(tokenHash)
      return { success: true }
    },
  }
}

function createApp({ store = createMemoryAuthStore(), now = () => Date.now(), nonceFactory, verifyMessage } = {}) {
  const app = express()
  app.use(express.json({ limit: '32kb' }))
  app.use('/api/auth/tron', createTronWalletAuthRouter({
    env: { FRONTEND_ORIGIN: origin, PACKAGED_APP_ORIGINS: 'tronstudio://app' },
    store,
    now,
    nonceFactory,
    verifyMessage,
  }))
  return app
}

async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api/auth/tron`
  try {
    await run(base)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

async function requestJson(base, path, { method = 'GET', body, token, requestOrigin = origin } = {}) {
  const headers = { Origin: requestOrigin, Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  const response = await fetch(base + path, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    credentials: 'omit',
    cache: 'no-store',
  })
  return { response, payload: await response.json() }
}

test('wallet login verifies a one-time signature and returns an identity-only wallet account/session', async () => {
  const store = createMemoryAuthStore()
  const app = createApp({
    store,
    nonceFactory: () => '1'.repeat(48),
    verifyMessage: async (message, suppliedSignature) => {
      assert.match(message, /Purpose: prove control of this public address only/)
      assert.match(message, new RegExp(`Address: ${address}`))
      assert.match(message, /Network: nile/)
      assert.match(message, new RegExp(`Origin: ${origin}`))
      assert.match(message, /Expires At:/)
      assert.equal(suppliedSignature, signature)
      return address
    },
  })
  await withServer(app, async (base) => {
    const challenge = await requestJson(base, '/challenge', {
      method: 'POST', body: { address, network: 'nile' },
    })
    assert.equal(challenge.response.status, 200)
    assert.equal(challenge.payload.success, true)
    assert.equal(challenge.payload.scope, 'wallet-identity-only')
    assert.equal(challenge.payload.canSubmitSponsoredTransfer, false)
    assert.match(challenge.response.headers.get('cache-control') || '', /no-store/)

    const verified = await requestJson(base, '/verify', {
      method: 'POST',
      body: { address, network: 'nile', nonce: challenge.payload.nonce, signature },
    })
    assert.equal(verified.response.status, 200)
    assert.equal(verified.payload.authenticated, true)
    assert.equal(verified.payload.address, address)
    assert.equal(verified.payload.scope, 'wallet-identity-only')
    assert.equal(verified.payload.canSubmitSponsoredTransfer, false)
    assert.equal(verified.payload.submissionEnabled, false)
    assert.equal(store.accounts.has('nile:' + address), true)
    assert.equal([...store.sessions.values()][0].origin, origin)

    const replay = await requestJson(base, '/verify', {
      method: 'POST',
      body: { address, network: 'nile', nonce: challenge.payload.nonce, signature },
    })
    assert.equal(replay.response.status, 401)
    assert.equal(replay.payload.error, 'challenge-expired-or-mismatched')

    const session = await requestJson(base, '/session', { token: verified.payload.sessionToken })
    assert.equal(session.response.status, 200)
    assert.equal(session.payload.authenticated, true)
    assert.equal(session.payload.address, address)
    assert.equal(session.payload.network, 'nile')
    assert.equal(session.payload.canSubmitSponsoredTransfer, false)
  })
})

test('a session can be resolved by another router instance sharing persistent storage', async () => {
  const store = createMemoryAuthStore()
  const nonceFactory = () => '3'.repeat(48)
  const verifyMessage = async () => address
  const challengeApp = createApp({ store, nonceFactory, verifyMessage })
  let sessionToken = ''
  await withServer(challengeApp, async (base) => {
    const challenge = await requestJson(base, '/challenge', {
      method: 'POST', body: { address, network: 'nile' },
    })
    const verified = await requestJson(base, '/verify', {
      method: 'POST',
      body: { address, network: 'nile', nonce: challenge.payload.nonce, signature },
    })
    assert.equal(verified.response.status, 200)
    sessionToken = verified.payload.sessionToken
  })

  const secondInstanceApp = createApp({ store })
  await withServer(secondInstanceApp, async (base) => {
    const session = await requestJson(base, '/session', { token: sessionToken })
    assert.equal(session.response.status, 200)
    assert.equal(session.payload.address, address)
  })
})

test('wallet login rejects invalid origin, wrong signer and unsupported non-TRON network', async () => {
  const store = createMemoryAuthStore()
  const app = createApp({
    store,
    nonceFactory: () => '2'.repeat(48),
    verifyMessage: async () => otherAddress,
  })
  await withServer(app, async (base) => {
    const wrongOrigin = await requestJson(base, '/challenge', {
      method: 'POST',
      requestOrigin: 'https://attacker.invalid',
      body: { address, network: 'nile' },
    })
    assert.equal(wrongOrigin.response.status, 403)
    assert.equal(wrongOrigin.payload.error, 'origin-not-allowed')

    const wrongNetwork = await requestJson(base, '/challenge', {
      method: 'POST', body: { address, network: 'ethereum' },
    })
    assert.equal(wrongNetwork.response.status, 400)
    assert.equal(wrongNetwork.payload.error, 'unsupported-network')

    const challenge = await requestJson(base, '/challenge', {
      method: 'POST', body: { address, network: 'nile' },
    })
    const verified = await requestJson(base, '/verify', {
      method: 'POST',
      body: { address, network: 'nile', nonce: challenge.payload.nonce, signature },
    })
    assert.equal(verified.response.status, 401)
    assert.equal(verified.payload.error, 'signature-address-mismatch')
    assert.equal(store.sessions.size, 0)
  })
})

test('Mainnet wallet ownership can be verified without enabling or submitting a transaction', async () => {
  const store = createMemoryAuthStore()
  const app = createApp({
    store,
    nonceFactory: () => '6'.repeat(48),
    verifyMessage: async (message) => {
      assert.match(message, /Network: mainnet/)
      assert.match(message, /no transfer is authorized/)
      return address
    },
  })
  await withServer(app, async (base) => {
    const challenge = await requestJson(base, '/challenge', {
      method: 'POST', body: { address, network: 'mainnet' },
    })
    assert.equal(challenge.response.status, 200)
    assert.equal(challenge.payload.network, 'mainnet')
    const verified = await requestJson(base, '/verify', {
      method: 'POST',
      body: { address, network: 'mainnet', nonce: challenge.payload.nonce, signature },
    })
    assert.equal(verified.response.status, 200)
    assert.equal(verified.payload.authenticated, true)
    assert.equal(verified.payload.network, 'mainnet')
    assert.equal(verified.payload.canSubmitSponsoredTransfer, false)
    assert.equal(verified.payload.submissionEnabled, false)
    assert.equal(store.accounts.has('mainnet:' + address), true)
    const session = await requestJson(base, '/session', { token: verified.payload.sessionToken })
    assert.equal(session.response.status, 200)
    assert.equal(session.payload.network, 'mainnet')
  })
})

test('logout revokes the bearer session and refuses an untrusted browser origin', async () => {
  const store = createMemoryAuthStore()
  const app = createApp({ store, nonceFactory: () => '4'.repeat(48), verifyMessage: async () => address })
  await withServer(app, async (base) => {
    const challenge = await requestJson(base, '/challenge', {
      method: 'POST', body: { address, network: 'nile' },
    })
    const verified = await requestJson(base, '/verify', {
      method: 'POST',
      body: { address, network: 'nile', nonce: challenge.payload.nonce, signature },
    })
    const token = verified.payload.sessionToken

    const deniedLogout = await requestJson(base, '/logout', {
      method: 'POST', token, requestOrigin: 'https://attacker.invalid',
    })
    assert.equal(deniedLogout.response.status, 403)

    const logout = await requestJson(base, '/logout', { method: 'POST', token })
    assert.equal(logout.response.status, 200)
    assert.equal(logout.payload.loggedOut, true)

    const session = await requestJson(base, '/session', { token })
    assert.equal(session.response.status, 401)
    assert.equal(session.payload.authenticated, false)
  })
})

test('challenge and verification fail closed if durable identity storage fails', async () => {
  const store = {
    async createChallenge() { return { success: false, reason: 'database-unavailable' } },
    async consumeChallenge() { return { success: false, reason: 'database-unavailable' } },
    async createSession() { return { success: false, reason: 'database-unavailable' } },
    async getSession() { return { success: false, reason: 'database-unavailable' } },
    async revokeSession() { return { success: false, reason: 'database-unavailable' } },
  }
  const app = createApp({ store, nonceFactory: () => '5'.repeat(48) })
  await withServer(app, async (base) => {
    const challenge = await requestJson(base, '/challenge', {
      method: 'POST', body: { address, network: 'nile' },
    })
    assert.equal(challenge.response.status, 503)
    assert.equal(challenge.payload.error, 'identity-storage-unavailable')
    assert.equal('nonce' in challenge.payload, false)
    assert.equal('message' in challenge.payload, true)
  })
})
