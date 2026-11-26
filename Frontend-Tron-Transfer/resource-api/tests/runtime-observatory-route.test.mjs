import test from 'node:test'
import assert from 'node:assert/strict'
import { createBoundedRateLimiter, createServer } from '../server.js'

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
    env: { TRON_OWNER_ADDRESS: owner },
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


test('observatory snapshot rate limit cannot be bypassed by spoofing X-Forwarded-For', async (t) => {
  const server = createServer({ env: {} })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const url = 'http://127.0.0.1:' + server.address().port + '/api/observatory/snapshot'
  let last
  for (let index = 0; index < 91; index += 1) {
    last = await fetch(url, {
      headers: {
        origin: 'https://tron-transfer.onrender.com',
        'x-forwarded-for': '198.51.100.' + (index % 250 + 1),
        'cf-connecting-ip': '203.0.113.77',
      },
    })
  }
  assert.equal(last.status, 429)
  assert.equal(last.headers.get('retry-after'), '60')
  assert.match(last.headers.get('access-control-expose-headers') || '', /Retry-After/i)
})


test('rate limiter bounds identity memory, fails closed at capacity, and reclaims expired entries', () => {
  let clock = 1_000
  const limiter = createBoundedRateLimiter({ windowMs: 60_000, maxEntries: 2, now: () => clock })

  assert.equal(limiter('ip-a', 2), true)
  assert.equal(limiter('ip-a', 2), true)
  assert.equal(limiter('ip-a', 2), false)
  assert.equal(limiter('ip-b', 2), true)
  assert.equal(limiter.size, 2)

  // An attacker cannot rotate identities to evict active counters.
  assert.equal(limiter('ip-c', 2), false)
  assert.equal(limiter.size, 2)
  assert.equal(limiter('ip-a', 2), false)

  // Once the window expires, capacity is reclaimed and the new identity works.
  clock += 60_000
  assert.equal(limiter('ip-c', 2), true)
  assert.equal(limiter.size, 1)
  assert.equal(limiter('ip-c', 2), true)
  assert.equal(limiter('ip-c', 2), false)
})


test('uptime history endpoint exposes persistent Git-backed probe records and caches them', async (t) => {
  let requests = 0
  const server = createServer({
    env: {},
    fetchImpl: async (url, options = {}) => {
      requests += 1
      assert.match(url, /^https:\/\/raw\.githubusercontent\.com\/MyTeleProject2026\/trc20-usdt-token-cloner\/monitoring-history\/history\/\d{4}-\d{2}-\d{2}\.json$/)
      assert.equal(options.method, 'GET')
      return new Response(JSON.stringify({
        schemaVersion: 1,
        records: [{
          id: 123,
          runNumber: 45,
          checkedAt: '2026-11-19T01:00:00Z',
          status: 'success',
          conclusion: 'success',
          url: 'https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/actions/runs/123',
          commit: 'a'.repeat(40),
          event: 'schedule',
          results: [{ name: 'runtime-observatory', ok: true, status: 200, latencyMs: 120, detail: 'healthy', metrics: { rssBytes: 4096, heapUsedBytes: 2048, eventLoopP95Ms: 3.5, p95LatencyMs: 12, errors5xx: 0 } }],
          private: 'must-not-be-exposed',
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const url = 'http://127.0.0.1:' + server.address().port + '/api/observatory/uptime-history'
  const first = await fetch(url)
  assert.equal(first.status, 200)
  const body = await first.json()
  assert.equal(body.success, true)
  assert.equal(body.provider, 'Git-backed GitHub history')
  assert.equal(body.storage, 'monitoring-history branch')
  assert.equal(body.retentionDays, null)
  assert.equal(body.runs[0].conclusion, 'success')
  assert.equal(body.runs[0].commit, 'aaaaaaaaaaaa')
  assert.equal(body.runs[0].results[0].latencyMs, 120)
  assert.equal(body.runs[0].results[0].metrics.rssBytes, 4096)
  assert.equal(body.runs[0].results[0].metrics.eventLoopP95Ms, 3.5)
  assert.equal(JSON.stringify(body).includes('must-not-be-exposed'), false)
  const second = await fetch(url)
  assert.equal(second.status, 200)
  assert.equal(requests, 2)
})

test('uptime history endpoint reports an empty archive without fabricating records', async (t) => {
  let requests = 0
  const server = createServer({
    env: {},
    fetchImpl: async () => {
      requests += 1
      return new Response('Not Found', { status: 404 })
    },
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/observatory/uptime-history')
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.success, true)
  assert.deepEqual(body.runs, [])
  assert.equal(body.totalRecords, 0)
  assert.equal(requests, 2)
})

test('Render metrics endpoint is server-authenticated, normalized, and honest about unsupported metrics', async (t) => {
  const requests = []
  const server = createServer({
    env: { RENDER_API_KEY: 'render-metrics-secret', RENDER_RESOURCE_API_SERVICE_ID: 'srv-api-test', RENDER_FRONTEND_SERVICE_ID: 'srv-web-test' },
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options })
      const metric = new URL(url).pathname.split('/').at(-1)
      if (metric === 'http-latency') return new Response(JSON.stringify({ error: 'not available on this plan' }), { status: 403 })
      return new Response(JSON.stringify([{
        labels: [{ field: 'service', value: 'srv-api-test' }],
        values: [{ timestamp: '2026-11-19T01:00:00Z', value: metric === 'cpu' ? 0.25 : 1024 }],
        unit: metric === 'cpu' ? 'CPU' : 'bytes',
      }]), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const url = 'http://127.0.0.1:' + server.address().port + '/api/observatory/render-metrics'
  const response = await fetch(url)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.success, true)
  assert.equal(body.configured, true)
  assert.equal(body.metrics.find(item => item.id === 'cpu').points[0].value, 0.25)
  assert.equal(body.metrics.find(item => item.id === 'http_latency').state, 'unavailable')
  assert.equal(JSON.stringify(body).includes('render-metrics-secret'), false)
  assert.equal(requests.length, 5)
  for (const request of requests) {
    assert.equal(request.options.headers.authorization, 'Bearer render-metrics-secret')
    assert.match(request.url, /^https:\/\/api\.render\.com\/v1\/metrics\//)
  }
})
