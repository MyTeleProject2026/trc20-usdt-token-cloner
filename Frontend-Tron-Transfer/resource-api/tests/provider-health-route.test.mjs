import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from '../server.js'

function blockResponse(number, status = 200) {
  return new Response(JSON.stringify({
    block_header: { raw_data: { number } },
  }), { status, headers: { 'content-type': 'application/json' } })
}

async function withServer(env, fetchImpl, run) {
  const server = createServer({ env, fetchImpl })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    await run('http://127.0.0.1:' + server.address().port)
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

const env = {
  TATUM_API_KEY: 'tatum-test-key',
  TATUM_TRON_NETWORK: 'mainnet',
  TRONGRID_API_KEY: 'trongrid-test-key',
}

test('provider health passes only when every configured Mainnet RPC provider responds', async () => {
  const calls = []
  await withServer(env, async url => {
    calls.push(String(url))
    return blockResponse(String(url).includes('tatum') ? 88331477 : 88331476)
  }, async base => {
    const response = await fetch(base + '/api/mainnet/provider-health')
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.allConfiguredProvidersHealthy, true)
    assert.deepEqual(body.providers.map(provider => provider.id), ['tatum', 'trongrid'])
    assert.ok(body.providers.every(provider => provider.reachable))
    assert.equal(body.blockHeightSpread, 1)
  })
  assert.equal(calls.length, 2)
})

test('provider health fails when one configured provider is unavailable even if fallback is live', async () => {
  await withServer(env, async url => {
    if (String(url).includes('tatum')) return blockResponse(0, 503)
    return blockResponse(88331476)
  }, async base => {
    const response = await fetch(base + '/api/mainnet/provider-health')
    const body = await response.json()
    assert.equal(response.status, 503)
    assert.equal(body.ok, false)
    assert.equal(body.allConfiguredProvidersHealthy, false)
    assert.equal(body.providers.find(provider => provider.id === 'tatum').reachable, false)
    assert.equal(body.providers.find(provider => provider.id === 'trongrid').reachable, true)
  })
})

test('provider health passes a single configured TronGrid provider without inventing a Tatum result', async () => {
  await withServer({ TRONGRID_API_KEY: 'trongrid-test-key' }, async () => blockResponse(88331476), async base => {
    const response = await fetch(base + '/api/mainnet/provider-health')
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.allConfiguredProvidersHealthy, true)
    assert.deepEqual(body.providers.map(provider => provider.id), ['trongrid'])
  })
})
