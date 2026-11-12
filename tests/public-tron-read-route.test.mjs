import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import express from 'express'
import { TronWeb } from 'tronweb'
import { createPublicTronReadRouter } from '../server/routes/public-tron-read.mjs'

const owner = 'TLBWTZHjjRMwbFgKgqmLwjp4ZKjxt5a2GT'
const target = owner
const token = 'A'.repeat(43)
const origin = 'https://tron-transfer.example'

async function withServer(t, router, callback) {
  const app = express()
  app.use('/api/public-tron', router)
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  await callback('http://127.0.0.1:' + server.address().port)
}

test('public TRON proxy requires a matching Mainnet owner session before reading', async (t) => {
  let calls = 0
  const router = createPublicTronReadRouter({
    env: { TREASURY_OWNER_ADDRESS: owner },
    getSession: async ({ origin: requestOrigin }) => ({
      success: true, session: { address: owner, network: 'mainnet', origin: requestOrigin },
    }),
    publicClient: {
      async getSolidifiedAccount() { calls++; return { address: target, balanceSun: '123', spendableBalanceOnly: true } },
    },
  })
  await withServer(t, router, async (baseUrl) => {
    const denied = await fetch(baseUrl + '/account/' + target)
    assert.equal(denied.status, 401)
    assert.equal(calls, 0)
    const allowed = await fetch(baseUrl + '/account/' + target, {
      headers: { Authorization: 'Bearer ' + token, Origin: origin },
    })
    const payload = await allowed.json()
    assert.equal(allowed.status, 200)
    assert.equal(payload.success, true)
    assert.equal(payload.data.balanceSun, '123')
    assert.equal(calls, 1)
  })
})

test('public TRON proxy rejects another wallet session', async (t) => {
  let calls = 0
  const otherAddress = TronWeb.address.fromHex('41' + 'd'.repeat(40))
  const router = createPublicTronReadRouter({
    env: { TREASURY_OWNER_ADDRESS: owner },
    getSession: async ({ origin: requestOrigin }) => ({
      success: true, session: { address: otherAddress, network: 'mainnet', origin: requestOrigin },
    }),
    publicClient: { async getSolidifiedAccount() { calls++; return { balanceSun: '0' } } },
  })
  await withServer(t, router, async (baseUrl) => {
    const response = await fetch(baseUrl + '/account/' + target, {
      headers: { Authorization: 'Bearer ' + token, Origin: origin },
    })
    assert.equal(response.status, 403)
    assert.equal(calls, 0)
  })
})

test('public TRON proxy rejects non-Mainnet sessions', async (t) => {
  const router = createPublicTronReadRouter({
    env: { TREASURY_OWNER_ADDRESS: owner },
    getSession: async ({ origin: requestOrigin }) => ({
      success: true, session: { address: owner, network: 'nile', origin: requestOrigin },
    }),
    publicClient: { async getSolidifiedAccount() { throw new Error('must not read') } },
  })
  await withServer(t, router, async (baseUrl) => {
    const response = await fetch(baseUrl + '/account/' + target, {
      headers: { Authorization: 'Bearer ' + token, Origin: origin },
    })
    assert.equal(response.status, 401)
  })
})
