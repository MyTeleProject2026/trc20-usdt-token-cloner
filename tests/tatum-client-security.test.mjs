import test from 'node:test'
import assert from 'node:assert/strict'
import { tatumApiBase, tatumFetch } from '../server/tatum-client.mjs'

const originalBase = process.env.TATUM_API_BASE
const originalKey = process.env.TATUM_API_KEY

function restoreEnv() {
  if (originalBase === undefined) delete process.env.TATUM_API_BASE
  else process.env.TATUM_API_BASE = originalBase
  if (originalKey === undefined) delete process.env.TATUM_API_KEY
  else process.env.TATUM_API_KEY = originalKey
}

test('uses only the approved HTTPS Tatum API origin', () => {
  try {
    delete process.env.TATUM_API_BASE
    assert.equal(tatumApiBase(), 'https://api.tatum.io')
    for (const value of [
      'http://api.tatum.io',
      'https://evil.example',
      'https://api.tatum.io.evil.example',
      'https://user:pass@api.tatum.io',
      'https://api.tatum.io/proxy',
    ]) {
      process.env.TATUM_API_BASE = value
      assert.throws(() => tatumApiBase(), /TATUM_API_BASE must be the approved HTTPS Tatum API origin/)
    }
  } finally {
    restoreEnv()
  }
})

test('rejects non-origin-relative paths before making a request', async () => {
  try {
    process.env.TATUM_API_BASE = 'https://api.tatum.io'
    process.env.TATUM_API_KEY = 'test-api-key-not-real'
    await assert.rejects(() => tatumFetch('https://evil.example/steal'), /Tatum API path must be an absolute path/)
    await assert.rejects(() => tatumFetch('//evil.example/steal'), /Tatum API path must be an absolute path/)
  } finally {
    restoreEnv()
  }
})


test('rejects redirects for authenticated Tatum requests even if the caller asks to follow them', async () => {
  const beforeBase = process.env.TATUM_API_BASE
  const beforeKey = process.env.TATUM_API_KEY
  process.env.TATUM_API_BASE = 'https://api.tatum.io'
  process.env.TATUM_API_KEY = 'test-api-key-not-real'
  let captured
  try {
    const payload = await tatumFetch('/v3/tron/info', {
      redirect: 'follow',
      headers: { 'x-api-key': 'caller-value-must-be-overridden' },
    }, {
      fetchImpl: async (url, init) => {
        captured = { url, init }
        return { ok: true, status: 200, text: async () => '{"success":true}' }
      },
    })
    assert.equal(payload.success, true)
    assert.equal(captured.url, 'https://api.tatum.io/v3/tron/info')
    assert.equal(captured.init.redirect, 'error')
    assert.equal(captured.init.headers.get('x-api-key'), 'test-api-key-not-real')
  } finally {
    if (beforeBase === undefined) delete process.env.TATUM_API_BASE
    else process.env.TATUM_API_BASE = beforeBase
    if (beforeKey === undefined) delete process.env.TATUM_API_KEY
    else process.env.TATUM_API_KEY = beforeKey
  }
})
