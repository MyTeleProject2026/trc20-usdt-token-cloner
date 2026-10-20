import test from 'node:test'
import assert from 'node:assert/strict'
import { tatumApiBase, tatumFetch } from '../server/tatum-client.mjs'

const originalBase = process.env.TATUM_API_BASE
const originalKey = process.env.TATUM_API_KEY

test('uses only the approved HTTPS Tatum API origin', () => {
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
  if (originalBase === undefined) delete process.env.TATUM_API_BASE
  else process.env.TATUM_API_BASE = originalBase
})

test('rejects non-origin-relative paths before making a request', async () => {
  process.env.TATUM_API_BASE = 'https://api.tatum.io'
  process.env.TATUM_API_KEY = 'test-api-key-not-real'
  await assert.rejects(() => tatumFetch('https://evil.example/steal'), /Tatum API path must be an absolute path/)
  await assert.rejects(() => tatumFetch('//evil.example/steal'), /Tatum API path must be an absolute path/)
  if (originalBase === undefined) delete process.env.TATUM_API_BASE
  else process.env.TATUM_API_BASE = originalBase
  if (originalKey === undefined) delete process.env.TATUM_API_KEY
  else process.env.TATUM_API_KEY = originalKey
})
