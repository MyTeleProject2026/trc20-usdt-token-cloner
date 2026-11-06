import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { payoutStatusFromProvider } from '../server/fincra-payout-status.mjs'

const recipientRoute = await readFile(new URL('../server/routes/tron-transfer.mjs', import.meta.url), 'utf8')
const withdrawalRoute = await readFile(new URL('../server/routes/tron-owner-withdrawals.mjs', import.meta.url), 'utf8')
const entry = await readFile(new URL('../server/index.mjs', import.meta.url), 'utf8')
const frontend = await readFile(new URL('../Frontend-Tron-Transfer/src/OwnerWithdrawals.jsx', import.meta.url), 'utf8')

test('recipient inspection remains read-only and Mainnet-only', () => {
  assert.match(recipientRoute, /const NETWORKS = Object\.freeze\(\{ mainnet: 'tron-mainnet' \}\)/)
  assert.match(recipientRoute, /network !== 'mainnet'/)
  assert.match(recipientRoute, /TATUM_MAINNET_API_KEY/)
  assert.match(recipientRoute, /walletsolidity\/getaccount/)
  assert.match(recipientRoute, /balanceOf\(address\)/)
  assert.match(recipientRoute, /MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'/)
  assert.doesNotMatch(recipientRoute, /tron-nile|tron-shasta/)
})

test('direct withdrawal route uses only the Tatum TRON Mainnet gateway and official USDT contract', () => {
  assert.match(withdrawalRoute, /MAINNET_GATEWAY = 'https:\/\/tron-mainnet\.gateway\.tatum\.io'/)
  assert.match(withdrawalRoute, /MAINNET_USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'/)
  assert.match(withdrawalRoute, /TATUM_MAINNET_API_KEY \|\| env\.TATUM_API_KEY/)
  assert.match(withdrawalRoute, /tatumProviderFetch\(MAINNET_GATEWAY/)
  assert.doesNotMatch(withdrawalRoute, /FINCRA|fincra|fireblocks/i)
})

test('withdrawal API binds owner privileges to the configured owner wallet and live session', () => {
  assert.match(withdrawalRoute, /OWNER_WALLET_ADDRESS/)
  assert.match(withdrawalRoute, /session\.address !== ownerAddress/)
  assert.match(withdrawalRoute, /session\.network !== 'mainnet'/)
  assert.match(withdrawalRoute, /session\.origin !== origin/)
  assert.match(withdrawalRoute, /getWalletAuthSession/)
})

test('owner snapshot reads actual USDT, TRX, Energy and Bandwidth through Tatum', () => {
  assert.match(withdrawalRoute, /walletsolidity\/getaccount/)
  assert.ok(withdrawalRoute.includes("'wallet/getaccountresource'"))
  assert.match(withdrawalRoute, /walletsolidity\/triggerconstantcontract/)
  assert.match(withdrawalRoute, /function_selector: 'balanceOf\(address\)'/)
  assert.match(withdrawalRoute, /usdtBalanceBaseUnits/)
  assert.match(withdrawalRoute, /energyAvailable/)
  assert.match(withdrawalRoute, /bandwidthAvailable/)
  assert.match(withdrawalRoute, /trxBalanceSun/)
})

test('withdrawal preparation checks real USDT funds and builds one exact TRC20 transfer', () => {
  assert.match(withdrawalRoute, /insufficient-mainnet-usdt-balance/)
  assert.match(withdrawalRoute, /function_selector: 'transfer\(address,uint256\)'/)
  assert.match(withdrawalRoute, /wallet\/triggerconstantcontract/)
  assert.match(withdrawalRoute, /wallet\/triggersmartcontract/)
  assert.match(withdrawalRoute, /TRANSFER_SELECTOR = 'a9059cbb'/)
  assert.match(withdrawalRoute, /transactionMatchesIntent/)
  assert.match(withdrawalRoute, /idempotency_key/)
  assert.match(withdrawalRoute, /status !== 'prepared'/)
})

test('prepared and unresolved withdrawals reserve owner USDT against concurrent allocations', () => {
  assert.match(withdrawalRoute, /readOwnerUsdtReservations/)
  assert.match(withdrawalRoute, /status='prepared' AND expires_at > now\(\)/)
  assert.match(withdrawalRoute, /'broadcasting','submitted','outcome-unknown','manual-review'/)
  assert.match(withdrawalRoute, /pg_advisory_xact_lock/)
  assert.match(withdrawalRoute, /availableForWithdrawalBaseUnits/)
})


test('broadcast requires the persisted intent and Tatum-validated configured-owner signature', () => {
  assert.match(withdrawalRoute, /validateOwnerSignedTransaction/)
  assert.match(withdrawalRoute, /wallet\/getapprovedlist/)
  assert.match(withdrawalRoute, /approved\?\.result\?\.result !== true/)
  assert.match(withdrawalRoute, /approvedAddresses\.includes\(auth\.address\)/)
  assert.match(withdrawalRoute, /wallet\/broadcasttransaction/)
  assert.match(withdrawalRoute, /signed_transaction/)
})

test('broadcast acceptance is pending until an exact solidified Tether Transfer is verified', () => {
  assert.match(withdrawalRoute, /verifySolidifiedUsdtTransfer/)
  assert.match(withdrawalRoute, /solidified/)
  assert.match(withdrawalRoute, /transfer-event/)
  assert.match(withdrawalRoute, /outcome-unknown/)
  assert.match(withdrawalRoute, /status === 'confirmed'/)
})

test('withdrawal endpoints are mounted in the API entrypoint', () => {
  assert.match(entry, /createTronOwnerWithdrawalsRouter/)
  assert.match(entry, /app\.use\('\/api\/tron-owner-withdrawals', createTronOwnerWithdrawalsRouter\(\)\)/)
  assert.match(frontend, /\/api\/tron-owner-withdrawals\/prepare/)
  assert.match(frontend, /\/api\/tron-owner-withdrawals\//)
})

test('frontend requests TronLink to sign and never sends a raw transaction itself', () => {
  assert.match(frontend, /wallet\.tronWeb\.trx\.sign\(prepared\.unsignedTransaction\)/)
  assert.ok(frontend.includes('/broadcast'))
  assert.doesNotMatch(frontend, /sendRawTransaction|privateKey\\s*[:=]/i)
})


test('Fincra automatic payout requires an allowlisted requester and an authorized matching standing mandate', () => {
  assert.match(recipientRoute, /FINCRA_AUTO_PAYOUTS_ENABLED !== 'true'/)
  assert.match(recipientRoute, /FINCRA_AUTO_PAYOUT_REQUESTER_ADDRESSES/)
  assert.match(recipientRoute, /authorized-fincra-standing-mandate-required/)
  assert.match(recipientRoute, /m\.execution_mode='fincra-automatic'/)
  assert.match(recipientRoute, /m\.provider_business_id=\$1/)
  assert.match(recipientRoute, /m\.per_payout_limit_base_units >= \$2/)
  assert.match(recipientRoute, /fincra-standing-mandate-daily-limit-exceeded/)
  assert.match(recipientRoute, /FOR UPDATE OF m/)
  assert.match(recipientRoute, /sponsor_mandate_id/)
})

test('owner-operated Fincra payout cannot substitute owner credentials for a third-party sponsor mandate', () => {
  assert.match(recipientRoute, /if \(ownerAuth\.ok && row\.requester_address !== ownerAuth\.address\)/)
  assert.match(recipientRoute, /owner-fincra-payout-requires-owner-requester-wallet/)
  assert.match(recipientRoute, /Other requesters require an authorized sponsor standing mandate/)
})

test('requesters can view and reconcile only their own Fincra payout history', async () => {
  const app = await readFile(new URL('../Frontend-Tron-Transfer/src/App.jsx', import.meta.url), 'utf8')
  assert.match(recipientRoute, /router\.get\('\/sponsor-requests\/mine'/)
  assert.match(recipientRoute, /router\.post\('\/sponsor-requests\/:id\/fincra-status'/)
  assert.match(recipientRoute, /router\.post\('\/sponsor-requests\/:id\/verify-recipient-transfer'/)
  assert.match(recipientRoute, /requester-does-not-own-this-payout-request/)
  assert.match(app, /FincraWithdrawals/)
})

test('Fincra frontend initiates provider submission and polls provider/solidified-chain reconciliation', async () => {
  const page = await readFile(new URL('../Frontend-Tron-Transfer/src/FincraWithdrawals.jsx', import.meta.url), 'utf8')
  const app = await readFile(new URL('../Frontend-Tron-Transfer/src/App.jsx', import.meta.url), 'utf8')
  assert.match(page, /\/api\/tron-transfer\/sponsor-requests/)
  assert.match(page, /\/fincra-payout/)
  assert.match(page, /\/fincra-status/)
  assert.match(page, /\/verify-recipient-transfer/)
  assert.match(page, /solidified-recipient-transfer-verified/)
  assert.doesNotMatch(page, /privateKey\s*[:=]/i)
})


test('Fincra pending payout status is not promoted to a payout lifecycle state', () => {
  assert.equal(payoutStatusFromProvider('pending'), 'unknown')
  assert.equal(payoutStatusFromProvider('PENDING'), 'unknown')
  assert.equal(payoutStatusFromProvider('processing'), 'processing')
  assert.equal(payoutStatusFromProvider('successful'), 'successful')
  assert.equal(payoutStatusFromProvider('failed'), 'failed')
  assert.equal(payoutStatusFromProvider('unknown-provider-state'), 'unknown')
})


test('unsupported Fincra payout statuses are not mapped into payout state', () => {
  assert.equal(payoutStatusFromProvider('pending'), 'unknown')
  assert.equal(payoutStatusFromProvider('initiated'), 'unknown')
  assert.equal(payoutStatusFromProvider('processing'), 'processing')
  assert.equal(payoutStatusFromProvider('successful'), 'successful')
  assert.equal(payoutStatusFromProvider('failed'), 'failed')
  assert.match(recipientRoute, /reason: 'unsupported-payout-status'/)
  assert.match(recipientRoute, /ignored: true/)
  assert.match(recipientRoute, /stateChanged: false/)
  assert.match(recipientRoute, /\['successful-payout-record-incomplete', 'unsupported-payout-status'\]\.includes\(reconciliation\.reason\)/)
})
