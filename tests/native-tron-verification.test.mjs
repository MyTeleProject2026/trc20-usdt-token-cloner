import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const route = await readFile(new URL('../server/routes/native-tron.mjs', import.meta.url), 'utf8')
const index = await readFile(new URL('../server/index.mjs', import.meta.url), 'utf8')
const app = await readFile(new URL('../src/WorkflowApp.tsx', import.meta.url), 'utf8')
const entry = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8')

test('native TRX verification is mounted and network-scoped', () => {
  assert.match(index, /nativeTronRoutes from '\.\/routes\/native-tron\.mjs'/)
  assert.match(index, /app\.use\('\/api\/tron', nativeTronRoutes\)/)
  assert.match(route, /router\.get\('\/verify-native-transfer\/:hash'/)
  assert.match(route, /shasta: 'https:\/\/api\.shasta\.trongrid\.io'/)
  assert.match(route, /walletsolidity\/gettransactionbyid/)
  assert.match(route, /walletsolidity\/gettransactioninfobyid/)
})

test('native TRX verification requires solidified body and receipt', () => {
  assert.match(route, /awaiting-solidification/)
  assert.match(route, /solidifiedReceiptPresent/)
  assert.match(route, /contractResult === 'SUCCESS'/)
  assert.match(route, /amountTRX/)
  assert.match(route, /1 TRX = 1000000 sun/)
})

test('native TRX verification is read-only and makes no exchange-credit claim', () => {
  assert.doesNotMatch(route, /privateKey|sendRawTransaction|broadcasttransaction|sendTrx\(/i)
  assert.match(route, /does not verify any TRC20 token balance or exchange deposit credit/)
})

test('native TRX receiver balance reads solidified state and preserves exact SUN values', () => {
  assert.match(route, /router\.get\('\/native-balance'/)
  assert.match(route, /walletsolidity\/getaccount/)
  assert.match(route, /balanceSun/)
  assert.match(route, /balanceTRX: formatSun\(balanceSun\)/)
  assert.match(route, /does not query TRC20 tokens or confirm exchange deposit credit/)
})

test('native TRX SUN formatting does not use floating-point conversion', () => {
  assert.match(route, /const formatSun = \(value\) => \{/)
  assert.match(route, /BigInt\(value\)/)
  assert.match(route, /amountTRX: actualAmountSun === null \? null : formatSun\(actualAmountSun\)/)
  assert.doesNotMatch(route, /Number\(actualAmountSun\)\s*\/\s*1_000_000/)
})

test('current frontend reads native balances from the selected testnet', () => {
  assert.ok(entry.includes("import App from './WorkflowApp.tsx'"))
  assert.ok(app.includes('/api/tron/native-balance?network='))
  assert.ok(app.includes('Verify receiver on selected network'))
  assert.ok(app.includes('Solidified TRX balance'))
  assert.ok(app.includes('does not confirm exchange deposit credit') || app.includes('exchange credit'))
})

test('current frontend connects or watches a testnet wallet without sending transactions', () => {
  assert.ok(app.includes('Connect / refresh TronLink'))
  assert.ok(app.includes('Watch-only address'))
  assert.ok(app.includes('Network mismatch. Select'))
  assert.ok(app.includes('checkedWalletNetwork(tronWeb, network)'))
  assert.ok(!app.includes('sendRawTransaction'))
  assert.ok(!app.includes('eth_sendTransaction'))
  assert.ok(!app.includes('window.confirm('))
})

test('backend readiness probes supported read-only Tatum data without exposing credentials', () => {
  assert.match(index, /const TATUM_TRON_HEALTH_PATH = '\/v4\/data\/blockchains\/block\/current\?chain=tron-mainnet'/)
  assert.match(index, /app\.get\('\/api\/status'/)
  assert.match(index, /await tatumFetch\(TATUM_TRON_HEALTH_PATH\)/)
  assert.match(index, /tatum\.reachable = true/)
  assert.match(index, /provider-unreachable/)
  assert.match(index, /isReadOnlyServiceReady from '\.\/readiness-policy\.mjs'/)
  assert.match(index, /isReadOnlyServiceReady\(\{ database, providers \}\)/)
  assert.match(index, /This endpoint tests database connectivity and a read-only Tatum API request/)
  assert.doesNotMatch(index, /TATUM_API_KEY:\s*process\.env\.TATUM_API_KEY/)
  assert.doesNotMatch(index, /await tatumFetch\('\/v3\/tron\/info'\)/)
})
