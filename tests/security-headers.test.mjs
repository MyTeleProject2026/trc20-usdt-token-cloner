import test from 'node:test'
import assert from 'node:assert/strict'
import { securityHeaders } from '../server/security-headers.mjs'

function responseRecorder() {
  const headers = new Map()
  return {
    headers,
    setHeader(name, value) { headers.set(name.toLowerCase(), value) },
  }
}

test('sets defensive headers on API responses', () => {
  const req = {}
  const res = responseRecorder()
  let continued = false
  securityHeaders(req, res, () => { continued = true })
  assert.equal(continued, true)
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(res.headers.get('x-frame-options'), 'DENY')
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(res.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()')
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/)
})

test('adds HSTS in production', () => {
  const original = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    const res = responseRecorder()
    securityHeaders({}, res, () => {})
    assert.equal(res.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains')
  } finally {
    if (original === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = original
  }
})
