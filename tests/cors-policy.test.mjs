import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createCorsPolicy } from '../server/cors-policy.mjs'

function responseRecorder() {
  const headers = new Map()
  return {
    headers,
    statusCode: 200,
    body: null,
    ended: false,
    setHeader(name, value) { headers.set(name.toLowerCase(), value) },
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
    end() { this.ended = true; return this },
  }
}

test('configured origins are normalized and only exact allowlisted browser origins pass', () => {
  const { allowedOrigins, middleware } = createCorsPolicy(
    'https://studio.example/,https://admin.example',
  )
  assert.deepEqual([...allowedOrigins].sort(), [
    'https://admin.example',
    'https://studio.example',
  ])

  const res = responseRecorder()
  let nextCalled = false
  middleware({ headers: { origin: 'https://studio.example' }, method: 'GET' }, res, () => {
    nextCalled = true
  })

  assert.equal(res.statusCode, 200)
  assert.equal(nextCalled, true)
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://studio.example')
  assert.equal(res.headers.get('vary'), 'Origin')
  assert.equal(res.headers.get('access-control-allow-methods'), 'GET,POST,OPTIONS')
  assert.equal(res.headers.get('access-control-max-age'), '600')
})

test('empty or invalid configuration fails closed for browser origins', () => {
  for (const configured of ['', 'not-a-url', 'javascript:alert(1)', 'http://studio.example', 'https://user:pass@admin.example']) {
    const { allowedOrigins, middleware } = createCorsPolicy(configured)
    assert.equal(allowedOrigins.size, 0)
    const res = responseRecorder()
    let nextCalled = false
    middleware({ headers: { origin: 'https://attacker.example' }, method: 'GET' }, res, () => {
      nextCalled = true
    })
    assert.equal(res.statusCode, 403)
    assert.deepEqual(res.body, { success: false, error: 'origin-not-allowed' })
    assert.equal(nextCalled, false)
    assert.equal(res.headers.has('access-control-allow-origin'), false)
  }
})

test('same-origin and command-line requests without an Origin header continue without reflecting an origin', () => {
  const { middleware } = createCorsPolicy('https://studio.example')
  const res = responseRecorder()
  let nextCalled = false
  middleware({ headers: {}, method: 'GET' }, res, () => { nextCalled = true })
  assert.equal(nextCalled, true)
  assert.equal(res.headers.has('access-control-allow-origin'), false)
})

test('preflight succeeds only for an allowlisted origin', () => {
  const { middleware } = createCorsPolicy('https://studio.example')
  const res = responseRecorder()
  let nextCalled = false
  middleware({
    headers: { origin: 'https://studio.example' },
    method: 'OPTIONS',
  }, res, () => { nextCalled = true })
  assert.equal(res.statusCode, 204)
  assert.equal(res.ended, true)
  assert.equal(nextCalled, false)

  const denied = responseRecorder()
  middleware({
    headers: { origin: 'https://evil.example' },
    method: 'OPTIONS',
  }, denied, () => { nextCalled = true })
  assert.equal(denied.statusCode, 403)
  assert.equal(denied.ended, false)
})


test('server entrypoint uses the fail-closed CORS policy and reports valid configuration', async () => {
  const entrypoint = await readFile(new URL('../server/index.mjs', import.meta.url), 'utf8')
  assert.match(entrypoint, /process\.env\.FRONTEND_ORIGIN/)
  assert.match(entrypoint, /process\.env\.PACKAGED_APP_ORIGINS/)
  assert.match(entrypoint, /createCorsPolicy\(configuredOrigins\)/)
  assert.match(entrypoint, /app\.use\(corsPolicy\)/)
  assert.match(entrypoint, /frontendOrigin: \{ configured: allowedOrigins\.size > 0 \}/)
  assert.doesNotMatch(entrypoint, /!allowedOrigins\.size\s*\|\|\s*allowedOrigins\.has\(origin\)/)
})


test('plain HTTP is accepted only for local development origins', () => {
  const { allowedOrigins, middleware } = createCorsPolicy('http://localhost:5173')
  assert.deepEqual([...allowedOrigins], ['http://localhost:5173'])
  const res = responseRecorder()
  let nextCalled = false
  middleware({ headers: { origin: 'http://localhost:5173' }, method: 'GET' }, res, () => {
    nextCalled = true
  })
  assert.equal(nextCalled, true)
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173')
})


test('desktop custom origin is accepted only for the exact explicitly configured app origin', () => {
  const { allowedOrigins, middleware } = createCorsPolicy(
    'https://studio.example,tronstudio://app',
  )
  assert.ok(allowedOrigins.has('tronstudio://app'))

  const allowed = responseRecorder()
  let nextCalled = false
  middleware({ headers: { origin: 'tronstudio://app' }, method: 'GET' }, allowed, () => {
    nextCalled = true
  })
  assert.equal(allowed.statusCode, 200)
  assert.equal(nextCalled, true)
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'tronstudio://app')

  for (const origin of ['tronstudio://app.attacker', 'tronstudio://other', 'tronstudio://app:8443']) {
    const denied = responseRecorder()
    let deniedNext = false
    middleware({ headers: { origin }, method: 'GET' }, denied, () => {
      deniedNext = true
    })
    assert.equal(denied.statusCode, 403, origin)
    assert.equal(deniedNext, false, origin)
  }
})


test('packaged-app origins are additive and never replace the hosted frontend allowlist', async () => {
  const entrypoint = await readFile(new URL('../server/index.mjs', import.meta.url), 'utf8')
  assert.match(entrypoint, /process\.env\.FRONTEND_ORIGIN/)
  assert.match(entrypoint, /process\.env\.PACKAGED_APP_ORIGINS/)
  assert.match(entrypoint, /\.filter\(\(value\) => typeof value === 'string' && value\.trim\(\)\)\.join\(','\)/)
  const configured = 'https://studio.example,https://localhost,tronstudio://app'
  const { allowedOrigins } = createCorsPolicy(configured)
  assert.ok(allowedOrigins.has('https://studio.example'))
  assert.ok(allowedOrigins.has('https://localhost'))
  assert.ok(allowedOrigins.has('tronstudio://app'))
})
