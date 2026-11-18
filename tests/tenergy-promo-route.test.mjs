import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { createTenergyPromoRouter } from '../server/routes/tenergy-promo.mjs'

const owner = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'

async function withServer(handler) {
  const app = express()
  app.use(express.json())
  app.use('/api/tron', createTenergyPromoRouter(handler))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  try { return await fetch('http://127.0.0.1:' + address.port) }
  finally { await new Promise((resolve) => server.close(resolve)) }
}

test('promo routes require the configured owner address before challenge or redemption', async () => {
  let calls = 0
  const response = await withServer({
    env: { OWNER_WALLET_ADDRESS: owner },
    promo: {
      async getPromo() { calls += 1; return { success: true } },
      async createChallenge() { calls += 1; return { success: true } },
      async redeem() { calls += 1; return { success: true } },
      async getRedemption() { calls += 1; return { success: true } },
    },
  })
  assert.equal(response.status, 404)
  assert.equal(calls, 0)
})

test('promo challenge rejects a different wallet before calling provider', async () => {
  let calls = 0
  const app = express()
  app.use(express.json())
  app.use('/api/tron', createTenergyPromoRouter({
    env: { OWNER_WALLET_ADDRESS: owner },
    promo: { async createChallenge() { calls += 1; return { success: true } } },
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/tron/resource-promo/challenge', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8' }),
    })
    const body = await response.json()
    assert.equal(response.status, 403)
    assert.equal(body.status, 'owner-wallet-mismatch')
    assert.equal(calls, 0)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('promo status attaches independent solidified Tatum resources only after provider says delegated', async () => {
  const app = express()
  app.use('/api/tron', createTenergyPromoRouter({
    env: { OWNER_WALLET_ADDRESS: owner, TATUM_API_KEY: 'test-only-secret' },
    promo: {
      async getRedemption() {
        return { success: true, address: owner, status: 'delegated', energy: 65000 }
      },
    },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://tron-mainnet.gateway.tatum.io/walletsolidity/getaccountresource')
      assert.equal(options.headers['x-api-key'], 'test-only-secret')
      return {
        ok: true,
        async json() {
          return { EnergyLimit: 65000, EnergyUsed: 0, NetLimit: 1000, NetUsed: 100 }
        },
      }
    },
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port
      + '/api/tron/resource-promo/status?address=' + encodeURIComponent(owner))
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.status, 'delegated')
    assert.equal(body.solidifiedOwnerResources.verified, true)
    assert.equal(body.solidifiedOwnerResources.currentlyAvailableEnergy, '65000')
    assert.equal(JSON.stringify(body).includes('test-only-secret'), false)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('promo status does not claim a resource grant when Tatum resource read is unavailable', async () => {
  const app = express()
  app.use('/api/tron', createTenergyPromoRouter({
    env: { OWNER_WALLET_ADDRESS: owner, TATUM_API_KEY: 'test-only-secret' },
    promo: { async getRedemption() { return { success: true, address: owner, status: 'delegated', energy: 65000 } } },
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port
      + '/api/tron/resource-promo/status?address=' + encodeURIComponent(owner))
    const body = await response.json()
    assert.equal(body.status, 'delegated')
    assert.equal(body.solidifiedOwnerResources.verified, false)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
