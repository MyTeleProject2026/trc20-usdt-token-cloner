import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, MAINNET_RPC } from '../server.js'

const ADDRESS = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const FAILURE_ADDRESS = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'

function mainnetPayload(url) {
  if (url.endsWith('/wallet/getaccountresource')) return {
    EnergyLimit: 100000, EnergyUsed: 10000, NetLimit: 800, NetUsed: 100,
    freeNetLimit: 600, freeNetUsed: 50,
  }
  if (url.endsWith('/wallet/getaccount')) return { address: ADDRESS, balance: 1234567 }
  if (url.endsWith('/wallet/getchainparameters')) return { chainParameter: [
    { key: 'getEnergyFee', value: 100 },
    { key: 'getTransactionFee', value: 1000 },
    { key: 'getMaxFeeLimit', value: 15000000000 },
  ] }
  throw new Error('Unexpected Mainnet RPC path: ' + url)
}

test('Resource API uses only TronGrid even when obsolete Tatum settings are present', async t => {
  const tronGridKey = 'test-trongrid-mainnet-key'
  const tatumKey = 'obsolete-tatum-key-must-not-be-used'
  const calls = []
  const server = createServer({
    env: { TRONGRID_API_KEY: tronGridKey, TATUM_API_KEY: tatumKey, TATUM_TRON_NETWORK: 'nile' },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options })
      return new Response(JSON.stringify(mainnetPayload(url)), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const base = 'http://127.0.0.1:' + server.address().port
  const health = await (await fetch(base + '/health')).json()
  assert.equal(health.rpcNode, 'trongrid')
  assert.equal(health.rpc, 'TronGrid Mainnet node API key configured')
  assert.equal(JSON.stringify(health).includes(tatumKey), false)
  const response = await fetch(base + '/v1/resources/' + ADDRESS)
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.energy.available, 90000)
  assert.equal(payload.rpc.providersUsed.accountResources, 'trongrid')
  assert.equal(payload.rpc.providersUsed.account, 'trongrid')
  assert.equal(payload.rpc.providersUsed.chainParameters, 'trongrid')
  assert.equal(calls.length, 1)
  assert.ok(calls.every(call => call.url.startsWith(MAINNET_RPC + '/wallet/')))
  assert.ok(calls.every(call => call.options.headers['TRON-PRO-API-KEY'] === tronGridKey))
  assert.equal(JSON.stringify(payload).includes(tatumKey), false)
})

test('Resource API does not fall back to another RPC node when TronGrid is unavailable', async t => {
  const calls = []
  const server = createServer({
    env: { TRONGRID_API_KEY: 'test-trongrid-key' },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options })
      return new Response(JSON.stringify({ Error: 'node unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } })
    },
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/v1/resources/' + FAILURE_ADDRESS)
  assert.equal(response.status, 503)
  assert.equal(calls.length, 3)
  assert.ok(calls.every(call => call.url.startsWith(MAINNET_RPC + '/wallet/')))
})
