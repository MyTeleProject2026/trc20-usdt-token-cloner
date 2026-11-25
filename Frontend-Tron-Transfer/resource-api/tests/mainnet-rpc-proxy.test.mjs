import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from '../server.js'

async function withServer(options, run) {
  const server = createServer(options)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const address = server.address()
    await run('http://127.0.0.1:' + address.port)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

test('Mainnet read RPC proxy keeps provider credentials server-side and caches duplicate reads', async () => {
  let upstreamCalls = 0
  const owner = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
  await withServer({
    env: { TRONGRID_API_KEY: 'server-only-test-key' },
    fetchImpl: async (url, options) => {
      upstreamCalls += 1
      assert.equal(String(url), 'https://api.trongrid.io/wallet/getaccount')
      assert.equal(options.headers['TRON-PRO-API-KEY'], 'server-only-test-key')
      return new Response(JSON.stringify({ address: '41b4319f8d0a2b57a62456e68556ef15f77cf1c898', balance: '35501899' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    },
  }, async base => {
    const request = () => fetch(base + '/api/tron/mainnet/rpc/wallet/getaccount', {
      method: 'POST',
      headers: { origin: 'https://tron-transfer.onrender.com', 'content-type': 'application/json' },
      body: JSON.stringify({ address: owner, visible: true }),
    })
    const first = await request()
    assert.equal(first.status, 200)
    assert.equal((await first.json()).balance, '35501899')
    const second = await request()
    assert.equal(second.status, 200)
    assert.equal((await second.json()).balance, '35501899')
    assert.equal(upstreamCalls, 1)
  })
})

test('Mainnet RPC proxy rejects write endpoints and never forwards them upstream', async () => {
  let upstreamCalls = 0
  await withServer({
    fetchImpl: async () => {
      upstreamCalls += 1
      return new Response('{}', { status: 200 })
    },
  }, async base => {
    const response = await fetch(base + '/api/tron/mainnet/rpc/wallet/broadcasttransaction', {
      method: 'POST',
      headers: { origin: 'https://tron-transfer.onrender.com', 'content-type': 'application/json' },
      body: JSON.stringify({ transaction: {} }),
    })
    assert.equal(response.status, 404)
    assert.equal((await response.json()).error, 'MAINNET_RPC_METHOD_NOT_ALLOWED')
    assert.equal(upstreamCalls, 0)
  })
})
