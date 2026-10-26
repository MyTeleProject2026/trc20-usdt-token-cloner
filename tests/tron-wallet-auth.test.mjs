import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createTronWalletAuthRouter } from '../server/routes/tron-wallet-auth.mjs'

const origin = 'https://trc20-usdt-token-cloner.onrender.com'
const address = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'
const otherAddress = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const signature = '0x' + 'a'.repeat(130)

async function withServer(handler) {
  const app = express()
  app.use(express.json())
  app.use('/api/auth/tron', createTronWalletAuthRouter({
    env: { FRONTEND_ORIGIN: origin },
    nonceFactory: (() => { let n = 0; return () => (++n).toString(16).padStart(48, '0') })(),
    verifyMessage: handler,
  }))
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api/auth/tron`
  try { await testContext(base) } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
}

async function testContext(base) {
  return base
}

async function post(base, path, body) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { response, payload: await response.json() }
}

test('wallet login verifies a one-time signature and returns identity-only session', async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/auth/tron', createTronWalletAuthRouter({
    env: { FRONTEND_ORIGIN: origin },
    nonceFactory: () => '1'.repeat(48),
    verifyMessage: async (message, suppliedSignature) => {
      assert.match(message, /Purpose: prove control of this public address only/)
      assert.match(message, new RegExp(`Address: ${address}`))
      assert.equal(suppliedSignature, signature)
      return address
    },
  }))
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api/auth/tron`
  try {
    const challenge = await post(base, '/challenge', { address, network: 'nile' })
    assert.equal(challenge.response.status, 200)
    assert.equal(challenge.payload.success, true)
    const verified = await post(base, '/verify', {
      address, network: 'nile', nonce: challenge.payload.nonce, signature,
    })
    assert.equal(verified.response.status, 200)
    assert.equal(verified.payload.authenticated, true)
    assert.equal(verified.payload.address, address)
    assert.equal(verified.payload.scope, 'wallet-identity-only')
    assert.equal(verified.payload.canSubmitSponsoredTransfer, false)
    assert.equal(verified.payload.submissionEnabled, false)

    const replay = await post(base, '/verify', {
      address, network: 'nile', nonce: challenge.payload.nonce, signature,
    })
    assert.equal(replay.response.status, 401)
    assert.equal(replay.payload.error, 'challenge-expired-or-mismatched')

    const session = await fetch(base + '/session', {
      headers: { Origin: origin, Authorization: `Bearer ${verified.payload.sessionToken}` },
    })
    const sessionPayload = await session.json()
    assert.equal(session.status, 200)
    assert.equal(sessionPayload.authenticated, true)
    assert.equal(sessionPayload.address, address)
    assert.equal(sessionPayload.canSubmitSponsoredTransfer, false)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test('wallet login rejects invalid origin, wrong signer, and non-testnet network', async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/auth/tron', createTronWalletAuthRouter({
    env: { FRONTEND_ORIGIN: origin },
    nonceFactory: () => '2'.repeat(48),
    verifyMessage: async () => otherAddress,
  }))
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api/auth/tron`
  try {
    const wrongOrigin = await fetch(base + '/challenge', {
      method: 'POST',
      headers: { Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, network: 'nile' }),
    })
    assert.equal(wrongOrigin.status, 403)

    const wrongNetwork = await post(base, '/challenge', { address, network: 'mainnet' })
    assert.equal(wrongNetwork.response.status, 400)

    const challenge = await post(base, '/challenge', { address, network: 'nile' })
    const verified = await post(base, '/verify', {
      address, network: 'nile', nonce: challenge.payload.nonce, signature,
    })
    assert.equal(verified.response.status, 401)
    assert.equal(verified.payload.error, 'signature-address-mismatch')
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
