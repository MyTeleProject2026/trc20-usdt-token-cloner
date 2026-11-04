import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const route = await readFile(new URL('../server/routes/tron-transfer.mjs', import.meta.url), 'utf8')
const entry = await readFile(new URL('../server/index.mjs', import.meta.url), 'utf8')

test('Tatum RPC proxy is network fixed, method allow-listed, and server-keyed', () => {
  assert.match(route, /TATUM_MAINNET_API_KEY/)
  assert.match(route, /TATUM_TESTNET_API_KEY/)
  assert.ok(route.includes("'x-api-key': key"))
  assert.match(route, /router\.all\('\/rpc\/:network\/\*'/)
  assert.match(route, /RPC_METHODS\.has\(method\)/)
  assert.doesNotMatch(route, /wallet\/broadcasttransaction'\s*,?\s*\n/)
})

test('signed Tatum broadcast is testnet-only and checks transaction identity before submission', () => {
  assert.match(route, /if \(!\['nile', 'shasta'\]\.includes\(network\)\)/)
  assert.match(route, /createHash\('sha256'\)\.update\(Buffer\.from\(rawHex, 'hex'\)\)/)
  assert.match(route, /signed-transaction-id-mismatch/)
  assert.match(route, /wallet\/broadcasttransaction/)
  assert.match(route, /broadcast-outcome-unknown/)
})

test('recipient inspection uses Tatum confirmed incoming history and reports balances', () => {
  assert.match(route, /walletsolidity\/getaccount/)
  assert.match(route, /onlyTo: true, onlyConfirmed: true/)
  assert.match(route, /incomingHistory: history/)
  assert.match(route, /balanceOf\(address\)/)
})

test('Fincra payout uses the USDT TRC20 scheme and refuses implicit live activation', () => {
  assert.match(route, /paymentDestination: 'crypto_wallet'/)
  assert.match(route, /paymentScheme: 'usdt_trc20'/)
  assert.match(route, /FINCRA_PAYOUTS_ENABLED/)
  assert.match(route, /FINCRA_LIVE_STABLECOIN_PAYOUTS_CONFIRMED/)
  assert.match(route, /sourceCurrency: 'USDT'/)
  assert.match(route, /live-stablecoin-payouts-not-confirmed/)
})

test('sponsor request intake requires a one-time Mainnet wallet identity session', () => {
  assert.match(route, /requireRequesterWalletSession\(req, env\)/)
  assert.match(route, /const requesterAddress = walletAuth\.address/)
  assert.match(route, /requester-address-does-not-match-wallet-session/)
  assert.match(route, /session\.network !== 'mainnet'/)
})

test('Fincra requests are owner-session gated, idempotently rechecked, and webhook signed', () => {
  assert.match(route, /requireOwnerSession\(req, env\)/)
  assert.match(route, /customer-reference\//)
  assert.match(route, /firstAttempt/)
  assert.match(route, /fincra-outcome-unknown/)
  assert.match(route, /createHmac\('sha512'/)
  assert.match(route, /timingSafeEqual/)
})

test('recipient transfer verification requires the official Mainnet USDT contract and exact amount', () => {
  assert.match(route, /row\.fincra_status !== 'successful'/)
  assert.match(route, /item\.tokenContract === MAINNET_USDT/)
  assert.match(route, /item\.amountBaseUnits === String\(row\.amount_base_units\)/)
  assert.match(route, /solidified-trc20-transfer-verified/)
  assert.match(route, /multiple-matching-incoming-transfers/)
  assert.match(route, /export async function verifySolidifiedUsdtTransfer/)
  assert.match(route, /walletsolidity\\/gettransactionbyid/)
  assert.match(route, /walletsolidity\\/gettransactioninfobyid/)
  assert.match(route, /TRANSFER_EVENT_TOPIC/)
  assert.match(route, /chain_verification_status='solidified-recipient-transfer-verified'/)
})

test('API entrypoint mounts the route and accepts only the configured Tron Transfer origin', () => {
  assert.match(entry, /process\.env\.TRON_TRANSFER_UI_ORIGIN/)
  assert.match(entry, /app\.use\('\/api\/tron-transfer', tronTransferRoutes\)/)
  assert.match(entry, /express\.raw\(\{ type: 'application\/json'/)
})
