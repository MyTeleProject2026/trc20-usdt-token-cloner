import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const route = await readFile(new URL('../server/routes/native-tron.mjs', import.meta.url), 'utf8')
const index = await readFile(new URL('../server/index.mjs', import.meta.url), 'utf8')

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


test('UI queries and labels receiver native balance from the selected network', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /handleQueryNativeBalance/)
  assert.match(app, /\/api\/tron\/native-balance/)
  assert.match(app, /Verify receiver TRX balance/)
  assert.match(app, /does not confirm exchange deposit credit/)
})


test('native transfer UI uses explicit TronLink approval and reflects selected network', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /Connect \/ verify TronLink/)
  assert.match(app, /Send Native ' \+ \(network === 'shasta' \? 'Shasta Testnet' : 'Mainnet'\) \+ ' TRX/)
  assert.match(app, /Never paste a seed phrase or private key into this tab/)
})
