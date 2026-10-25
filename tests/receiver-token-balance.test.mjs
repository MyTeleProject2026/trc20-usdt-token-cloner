import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { isCanonicalMainnetUsdtContract } from '../server/routes/tatum.mjs'

const routes = await readFile(new URL('../server/routes/tatum.mjs', import.meta.url), 'utf8')
const app = await readFile(new URL('../src/WorkflowApp.tsx', import.meta.url), 'utf8')

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

test('receiver token balance rejects malformed ABI results and decimals outside the UI-supported range', () => {
  assert.match(routes, /typeof data\.constant_result\[0\] !== 'string'/)
  assert.match(routes, /!\/\^\[0-9a-f\]\+\$\/i\.test\(data\.constant_result\[0\]\)/)
  assert.match(routes, /const decimalsBigInt = BigInt\('0x' \+ decimalsHex\)/)
  assert.match(routes, /decimalsBigInt > 30n/)
  assert.match(routes, /error: 'unsupported-token-decimals'/)
  assert.match(routes, /selected contract returned decimals outside the supported display range/)
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

test('active workflow reads selected token balances from the exact contract and testnet', () => {
  assert.ok(app.includes('/api/tron/token-balance?network='))
  assert.ok(app.includes('contract: string'))
  assert.ok(app.includes('Token contract address on'))
  assert.ok(app.includes('selected testnet'))
  assert.ok(app.includes('senderTokenSnapshot?.decimals'))
  assert.ok(app.includes('Verify receiver on selected network'))
  assert.ok(!app.includes('/api/tron/verified-transfer/'))
  assert.ok(!app.includes('/api/gasfree/submit'))
})

test('receiver balance UI shows exact chain, contract, base units, and snapshot time', () => {
  assert.match(app, /Receiver on-chain balance · solidified/);
  assert.match(app, /receiverSnapshot\.network/);
  assert.match(app, /receiverSnapshot\.tokenContract \|\| tokenContract\.trim\(\)/);
  assert.match(app, /receiverSnapshot\.balanceBaseUnits/);
  assert.match(app, /receiverCheckedAt \? new Date\(receiverCheckedAt\)\.toLocaleString\(\)/);
  assert.match(app, /transfer is marked received only after its exact transaction and solidified transfer event are independently verified/);
});

test('verified transfer lookup remains read-only and requires exact event identity', () => {
  assert.match(routes, /router\.get\('\/tron\/verified-transfer\/:hash'/)
  const start = routes.indexOf("router.get('/tron/verified-transfer/:hash'")
  const end = routes.indexOf("// Contract deployment is performed", start)
  assert.ok(start >= 0 && end > start)
  const endpoint = routes.slice(start, end)
  for (const field of ['network', 'contract', 'from', 'to', 'amountSun', 'logIndex']) {
    assert.match(endpoint, new RegExp(field))
  }
  assert.match(endpoint, /findVerifiedTransfer\(/)
  assert.match(endpoint, /verified-transfer-not-found/)
  assert.doesNotMatch(endpoint, /privateKey|broadcasttransaction|sendRawTransaction/i)
})

test('chain verification reports persistence separately from chain success', () => {
  assert.match(routes, /persistence: persistence\?\.persisted/)
  assert.match(routes, /reason: persistence\?\.reason \|\| 'persistence-unavailable'/)
})

test('official Mainnet USDT verification remains independently allowlisted on the backend only', () => {
  assert.match(routes, /OFFICIAL_MAINNET_USDT_HEX = 'a614f803b6fd780986a42c78ec9c7f77e6ded13c'/)
  assert.match(routes, /const isOfficialMainnetUsdt = isCanonicalMainnetUsdtContract\(network, contract\)/)
  assert.match(routes, /normalizedContract === OFFICIAL_MAINNET_USDT_HEX/)
  assert.match(routes, /if \(!isOfficialMainnetUsdt && !approvedContracts\.length\)/)
  assert.match(routes, /if \(!isOfficialMainnetUsdt && !approvedContracts\.includes\(normalizedContract\)\)/)
  assert.match(routes, /No other contract is implicitly trusted/)
})

test('built-in USDT verifier allowlist is exact and Mainnet-only', () => {
  const contractPayload = 'a614f803b6fd780986a42c78ec9c7f77e6ded13c'
  assert.equal(isCanonicalMainnetUsdtContract('mainnet', contractPayload), true)
  assert.equal(isCanonicalMainnetUsdtContract('mainnet', '41' + contractPayload), true)
  assert.equal(isCanonicalMainnetUsdtContract('shasta', contractPayload), false)
  assert.equal(isCanonicalMainnetUsdtContract('nile', contractPayload), false)
  assert.equal(isCanonicalMainnetUsdtContract('mainnet', 'b'.repeat(40)), false)
  assert.equal(isCanonicalMainnetUsdtContract('mainnet', 'not-an-address'), false)
})
