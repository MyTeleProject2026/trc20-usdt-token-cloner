import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from '../server.js'

const owner = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'

test('runtime snapshot endpoint returns live process heartbeat and never exposes environment values', async (t) => {
  const server = createServer({ env: { TATUM_API_KEY: 'never-return-this-secret' } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/observatory/snapshot')
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.service, 'tron-transfer-resource-api')
  assert.equal(body.heartbeat.state, 'online')
  assert.equal(body.heartbeat.intervalMs, 1000)
  assert.equal(JSON.stringify(body).includes('never-return-this-secret'), false)
})

test('confirmed Mainnet transaction feed is owner restricted and requests confirmed records only', async (t) => {
  let requestBody
  const tx = { txID: 'a'.repeat(64), blockNumber: 12345, ret: [{ contractRet: 'SUCCESS' }] }
  const server = createServer({
    env: {},
    fetchImpl: async (url, options = {}) => {
      assert.match(url, /^https:\/\/api\.trongrid\.io\/v1\/accounts\/TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp\/transactions\?/)
      assert.equal(options.method, 'GET')
      requestBody = Object.fromEntries(new URL(url).searchParams.entries())
      return new Response(JSON.stringify({ success: true, data: [tx] }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const base = 'http://127.0.0.1:' + server.address().port
  const denied = await fetch(base + '/api/observatory/transactions?address=TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL')
  assert.equal(denied.status, 403)
  const response = await fetch(base + '/api/observatory/transactions?address=' + owner)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.success, true)
  assert.equal(body.confirmedOnly, true)
  assert.deepEqual(body.transactions, [tx])
  assert.equal(requestBody.only_confirmed, 'true')
  assert.equal(requestBody.limit, '20')
  assert.equal(requestBody.order_by, 'block_timestamp,desc')
})


test('Render control-plane feed is read only, server-authenticated, and returns sanitized event metadata', async (t) => {
  const requests = []
  const server = createServer({
    env: { RENDER_API_KEY: 'render-secret-never-return-this', RENDER_RESOURCE_API_SERVICE_ID: 'srv-api-test', RENDER_FRONTEND_SERVICE_ID: 'srv-web-test' },
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options })
      return new Response(JSON.stringify([{ event: { id: 'evt-1', timestamp: '2026-11-18T12:00:00.000Z', serviceId: 'srv-api-test', type: 'deploy_ended', details: { message: 'private-build-output' } }, cursor: 'cursor-1' }]), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/observatory/render-events')
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.configured, true)
  assert.equal(body.events.length, 2)
  assert.equal(body.events[0].type, 'deploy_ended')
  assert.equal(JSON.stringify(body).includes('render-secret-never-return-this'), false)
  assert.equal(JSON.stringify(body).includes('private-build-output'), false)
  assert.equal(requests.length, 2)
  for (const request of requests) {
    assert.equal(request.options.headers.authorization, 'Bearer render-secret-never-return-this')
    assert.match(request.url, /^https:\/\/api\.render\.com\/v1\/services\//)
    assert.equal(request.options.method, 'GET')
  }
})

test('Render control-plane feed degrades honestly when no API key is configured', async (t) => {
  const server = createServer({ env: {} })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/observatory/render-events')
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.configured, false)
  assert.deepEqual(body.events, [])
  assert.match(body.note, /RENDER_API_KEY/)
})
