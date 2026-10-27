import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const route = await readFile(new URL('../server/routes/okx-deposit-status.mjs', import.meta.url), 'utf8')
const index = await readFile(new URL('../server/index.mjs', import.meta.url), 'utf8')
const guard = await readFile(new URL('../server/credential-guard.mjs', import.meta.url), 'utf8')

test('OKX adapter is registered as a read-only API route', () => {
  assert.match(index, /import okxDepositStatusRoutes from '\.\/routes\/okx-deposit-status\.mjs'/)
  assert.match(index, /app\.use\('\/api\/okx', okxDepositStatusRoutes\)/)
  assert.match(route, /\/api\/v5\/asset\/deposit-history/)
  assert.doesNotMatch(route, /\/withdrawal|\/transfer|POST|PUT|DELETE/i)
})

test('OKX requests are HMAC signed on the server and require a separate bearer gate', () => {
  assert.match(route, /OKX_API_KEY/)
  assert.match(route, /OKX_API_SECRET/)
  assert.match(route, /OKX_API_PASSPHRASE/)
  assert.match(route, /OKX_STATUS_ACCESS_TOKEN/)
  assert.match(route, /createHmac\('sha256'/)
  assert.match(route, /OK-ACCESS-SIGN/)
  assert.match(route, /constantTimeEqual\(supplied, accessToken\)/)
  assert.match(guard, /process\.env\.OKX_API_SECRET/)
  assert.match(guard, /process\.env\.OKX_STATUS_ACCESS_TOKEN/)
})

test('only actual OKX deposit records create displayed statuses', () => {
  assert.match(route, /payload\.code !== '0'/)
  assert.match(route, /Array\.isArray\(payload\.data\)/)
  assert.match(route, /payload\.data\.map\(safeDeposit\)/)
  assert.match(route, /source: 'OKX authenticated deposit-history response'/)
  assert.match(route, /No credit status was inferred/)
  assert.doesNotMatch(route, /creditExchangeBalance|incrementExchangeBalance|fabricat/i)
})

test('deposit-history filters and response caching are constrained', () => {
  assert.match(route, /MAX_LIMIT = 100/)
  assert.match(route, /invalid-transaction-id/)
  assert.match(route, /invalid-after/)
  assert.match(route, /Cache-Control', 'no-store, private'/)
  assert.match(route, /redirect: 'error'/)
})
