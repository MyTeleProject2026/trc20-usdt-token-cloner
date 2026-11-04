import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const route = await readFile(new URL('../server/routes/tron-transfer.mjs', import.meta.url), 'utf8')
const entry = await readFile(new URL('../server/index.mjs', import.meta.url), 'utf8')

test('Tatum proxy is restricted to Mainnet and read-only RPC methods', () => {
  assert.match(route, /const NETWORKS = Object\.freeze\(\{ mainnet: 'tron-mainnet' \}\)/)
  assert.match(route, /network !== 'mainnet' \|\| !RPC_METHODS\.has\(method\)/)
  assert.match(route, /TATUM_MAINNET_API_KEY/)
  assert.doesNotMatch(route, /tron-nile|tron-shasta|wallet\/broadcasttransaction/)
})

test('direct wallet broadcasts are disabled; Mainnet sponsor payout is the only send rail', () => {
  assert.match(route, /direct-wallet-broadcast-disabled/)
  assert.match(route, /transactionSubmitted: false/)
  assert.match(route, /paymentDestination: 'crypto_wallet'/)
  assert.match(route, /paymentScheme: 'usdt_trc20'/)
  assert.match(route, /sourceCurrency: 'USDT'/)
})

test('recipient inspection only reads Mainnet official USDT balances and incoming history', () => {
  assert.match(route, /network !== 'mainnet'/)
  assert.match(route, /tokenContract !== MAINNET_USDT/)
  assert.match(route, /walletsolidity\/getaccount/)
  assert.match(route, /balanceOf\(address\)/)
  assert.match(route, /readTronGridIncomingHistory/)
  assert.match(route, /historyProvider: 'trongrid'/)
})

test('Fincra source-balance parser accepts array and object wallet-list response shapes', () => {
  assert.match(route, /Array\.isArray\(data\?\.results\)/)
  assert.match(route, /Array\.isArray\(data\?\.accounts\)/)
  assert.match(route, /Array\.isArray\(data\?\.balances\)/)
  assert.match(route, /data\.availableBalance !== undefined/)
  assert.match(route, /availableBaseUnits/)
})

test('Fincra live payout requires provider enablement, source funds, Tatum Mainnet and database readiness', () => {
  assert.match(route, /config\.mode !== 'live'/)
  assert.match(route, /FINCRA_LIVE_STABLECOIN_PAYOUTS_CONFIRMED/)
  assert.match(route, /canSubmitLivePayout/)
  assert.doesNotMatch(route, /canSubmitSandboxPayout/)
  assert.match(route, /sourceBalanceBaseUnits > 0n/)
  assert.match(route, /availableBaseUnits < BigInt\(row\.amount_base_units\)/)
})

test('Fincra payout amounts use exact six-decimal formatting before numeric API serialization', () => {
  assert.match(route, /maxFincraBaseUnits = 1_000_000_000_000_000n/)
  assert.match(route, /const normalizedFraction = fraction\.padEnd\(6, '0'\)\.replace\(\/0\+\$\//)
  assert.doesNotMatch(route, /Number\(baseUnits\) \/ 1_000_000/)
})

test('duplicate Fincra customer references become unknown and never falsely failed', () => {
  assert.match(route, /DUPLICATE_CUSTOMER_REFERENCE/)
  assert.match(route, /fincra-duplicate-customer-reference/)
  assert.match(route, /transactionSubmitted: 'unknown'/)
})

test('an ambiguous Fincra submission can never be automatically resubmitted after a 404 lookup', () => {
  assert.match(route, /let firstAttempt = false/)
  assert.match(route, /firstAttempt = true/)
  assert.match(route, /if \(!firstAttempt\)/)
  assert.match(route, /fincra-retry-requires-manual-reconciliation/)
  assert.match(route, /customer-reference\//)
})

test('Fincra settlement timestamps are persisted and used to bound exact on-chain recipient verification', () => {
  assert.match(route, /ADD COLUMN IF NOT EXISTS fincra_submitted_at TIMESTAMPTZ/)
  assert.match(route, /ADD COLUMN IF NOT EXISTS fincra_successful_at TIMESTAMPTZ/)
  assert.match(route, /fincra_successful_at=CASE WHEN/)
  assert.match(route, /fincra-status-requery/)
  assert.match(route, /payoutStartMs/)
  assert.match(route, /payoutEndMs/)
  assert.match(route, /verifySolidifiedUsdtTransfer/)
  assert.match(route, /item\.tokenContract === MAINNET_USDT/)
})

test('Fincra webhook remains raw-body HMAC-SHA512 verified', () => {
  assert.match(route, /createHmac\('sha512'/)
  assert.match(route, /timingSafeEqual/)
  assert.match(route, /req\.headers\?\.signature/)
})

test('API entrypoint mounts Tron Transfer and only accepts its configured frontend origin', () => {
  assert.match(entry, /TRON_TRANSFER_UI_ORIGIN/)
  assert.match(entry, /app\.use\('\/api\/tron-transfer', tronTransferRoutes\)/)
})

test('live Fincra payout performs server-side official Mainnet USDT recipient preflight before submission', () => {
  assert.match(route, /async function preflightMainnetUsdtRecipient\(address\)/)
  assert.match(route, /walletsolidity\/getaccount/)
  assert.match(route, /function_selector: 'balanceOf\(address\)'/)
  assert.match(route, /function_selector: 'decimals\(\)'/)
  assert.match(route, /Number\(BigInt\('0x' \+ decimalsHex\)\) === 6/)
  assert.match(route, /const recipientPreflight = await preflightMainnetUsdtRecipient\(row\.recipient_address\)/)
  assert.match(route, /recipient-mainnet-preflight-failed/)
  assert.ok(route.indexOf('const recipientPreflight = await preflightMainnetUsdtRecipient(row.recipient_address)') < route.indexOf('const created = await fincraRequest(config, \'/disbursements/payouts\''))
})
