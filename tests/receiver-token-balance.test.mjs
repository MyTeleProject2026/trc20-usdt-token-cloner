import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const routes = await readFile(new URL('../server/routes/tatum.mjs', import.meta.url), 'utf8')

test('receiver token balance endpoint is read-only and network-scoped', () => {
  assert.match(routes, /router\.get\('\/tron\/token-balance'/)
  assert.match(routes, /mainnet: 'https:\/\/tron-mainnet\.gateway\.tatum\.io'/)
  assert.match(routes, /shasta: 'https:\/\/tron-shasta\.gateway\.tatum\.io'/)
  assert.match(routes, /nile: 'https:\/\/tron-nile\.gateway\.tatum\.io'/)
  assert.match(routes, /walletsolidity\/triggerconstantcontract/)
  assert.match(routes, /balanceOf\(address\)/)
  assert.match(routes, /'x-api-key': process\.env\.TATUM_API_KEY/)
  assert.match(routes, /Set TATUM_API_KEY in the backend environment/)
  assert.match(routes, /Tatum TRON Solidity HTTP gateway triggerconstantcontract/)
  assert.match(routes, /TRON-PRO-API-KEY/)
  assert.match(routes, /AbortSignal\.timeout\(8000\)/)
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
  assert.doesNotMatch(endpoint, /api\.trongrid\.io|TRON-PRO-API-KEY|TRONGRID_API_KEY/)
  assert.match(endpoint, /tron-mainnet\.gateway\.tatum\.io/)
  assert.match(endpoint, /tron-shasta\.gateway\.tatum\.io/)
  assert.match(endpoint, /tron-nile\.gateway\.tatum\.io/)
})


test('frontend exposes a solidified receiver token balance check for the selected contract and network', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /handleQueryTokenBalance/)
  assert.match(app, /\/api\/tron\/token-balance/)
  assert.match(app, /Verify receiver token balance/)
  assert.match(app, /formatTokenUnits\(tokenBalanceResult\.balanceBaseUnits, tokenBalanceResult\.decimals\)/)
  assert.match(app, /does not prove exchange deposit credit or that the token is official USDT/)
})
