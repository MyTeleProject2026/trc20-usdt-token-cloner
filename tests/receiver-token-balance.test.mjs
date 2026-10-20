import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const routes = await readFile(new URL('../server/routes/tatum.mjs', import.meta.url), 'utf8')

test('receiver token balance endpoint is read-only and network-scoped', () => {
  assert.match(routes, /router\.get\('\/tron\/token-balance'/)
  assert.match(routes, /mainnet: 'https:\/\/api\.trongrid\.io'/)
  assert.match(routes, /shasta: 'https:\/\/api\.shasta\.trongrid\.io'/)
  assert.match(routes, /nile: 'https:\/\/nile\.trongrid\.io'/)
  assert.match(routes, /walletsolidity\/triggerconstantcontract/)
  assert.match(routes, /balanceOf\(address\)/)
  assert.match(routes, /balanceBaseUnits/)
  assert.match(routes, /does not imply exchange deposit credit/)
})

test('receiver balance endpoint does not sign or broadcast transfers', () => {
  const start = routes.indexOf("router.get('/tron/token-balance'")
  const end = routes.indexOf("router.get('/tron/contract-by-tx/:hash'")
  assert.ok(start >= 0 && end > start)
  const endpoint = routes.slice(start, end)
  assert.doesNotMatch(endpoint, /privateKey|broadcasttransaction|sendRawTransaction|wallet\/broadcasttransaction/i)
  assert.match(endpoint, /network must be mainnet, shasta, or nile/)
})
