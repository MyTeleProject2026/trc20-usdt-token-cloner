import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, TATUM_MAINNET_RPC } from '../server.js'

const address = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'

function resourceResponse(url) {
  if (url.endsWith('/wallet/getaccountresource')) return {
    EnergyLimit: 120000, EnergyUsed: 20000,
    NetLimit: 900, NetUsed: 100, freeNetLimit: 600, freeNetUsed: 50,
  }
  if (url.endsWith('/wallet/getaccount')) return { balance: 0 }
  if (url.endsWith('/wallet/getchainparameters')) return { chainParameter: [
    { key: 'getEnergyFee', value: 100 },
    { key: 'getTransactionFee', value: 1000 },
    { key: 'getMaxFeeLimit', value: 15000000000 },
  ] }
  throw new Error('unexpected RPC URL: ' + url)
}

test('Tatum Mainnet RPC is preferred and its API key stays server-side', async t => {
  const secret = 'test-tatum-mainnet-key'
  const calls = []
  const server = createServer({
    env: { TATUM_API_KEY: secret },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options })
      return new Response(JSON.stringify(resourceResponse(url)), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    },
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const base = 'http://127.0.0.1:' + server.address().port

  const health = await fetch(base + '/health')
  const healthBody = await health.json()
  assert.equal(healthBody.rpcProviderPriority[0], 'tatum')
  assert.equal(JSON.stringify(healthBody).includes(secret), false)

  const response = await fetch(base + '/v1/resources/' + address)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.energy.available, 100000)
  assert.equal(body.bandwidth.maxSingleTransactionAvailable, 800)
  assert.equal(calls.length, 3)
  assert.ok(calls.every(call => call.url.startsWith(TATUM_MAINNET_RPC + '/wallet/')))
  assert.ok(calls.every(call => call.options.headers['x-api-key'] === secret))
  assert.equal(JSON.stringify(body).includes(secret), false)
})

test('Tatum RPC failures fall back to TronGrid without changing resource semantics', async t => {
  // Use a distinct address so the service's process-level resource cache cannot
  // let the preceding preferred-provider test satisfy this request.
  const fallbackAddress = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
  const calls = []
  const server = createServer({
    env: { TATUM_API_KEY: 'test-tatum-key', TRONGRID_API_KEY: 'test-trongrid-key' },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options })
      if (url.startsWith(TATUM_MAINNET_RPC)) {
        return new Response(JSON.stringify({ error: 'temporarily unavailable' }), {
          status: 503, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify(resourceResponse(url)), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    },
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/v1/resources/' + fallbackAddress)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.energy.available, 100000)
  assert.equal(calls.filter(call => call.url.startsWith(TATUM_MAINNET_RPC)).length, 3)
  const tronGridCalls = calls.filter(call => call.url.startsWith('https://api.trongrid.io/'))
  assert.equal(tronGridCalls.length, 3)
  assert.ok(tronGridCalls.every(call => call.options.headers['TRON-PRO-API-KEY'] === 'test-trongrid-key'))
})
