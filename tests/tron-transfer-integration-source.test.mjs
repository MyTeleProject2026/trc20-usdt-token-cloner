import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { payoutStatusFromProvider } from '../server/fincra-payout-status.mjs'

const recipientRoute = await readFile(new URL('../server/routes/tron-transfer.mjs', import.meta.url), 'utf8')
const sponsorRoute = await readFile(new URL('../server/routes/sponsor-direct-payouts.mjs', import.meta.url), 'utf8')
const sponsorFrontend = await readFile(new URL('../Frontend-Tron-Transfer/src/SponsorDirectPayouts.jsx', import.meta.url), 'utf8')
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

test('self-funded direct owner wallet withdrawal route and page are not exposed by the private provider-funded runtime', async () => {
  const app = await readFile(new URL('../Frontend-Tron-Transfer/src/App.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(entry, /createTronOwnerWithdrawalsRouter|tron-owner-withdrawals/)
  assert.doesNotMatch(app, /OwnerWithdrawals|tron-owner-withdrawals/)
  // The isolated route source remains covered for historical safety regression,
  // but the deployed API does not mount it in provider-funded mode.
  assert.match(withdrawalRoute, /insufficient-mainnet-usdt-balance/)
  assert.match(withdrawalRoute, /validateOwnerSignedTransaction/)
})

test('frontend requests TronLink to sign and never sends a raw transaction itself', () => {
  assert.match(frontend, /wallet\.tronWeb\.trx\.sign\(prepared\.unsignedTransaction\)/)
  assert.ok(frontend.includes('/broadcast'))
  assert.doesNotMatch(frontend, /sendRawTransaction|privateKey\\s*[:=]/i)
})



test('payout wallet sessions are restricted to the configured private platform owner', () => {
  assert.match(recipientRoute, /const configuredOwner = cleanString\(env\.OWNER_WALLET_ADDRESS \|\| env\.TREASURY_OWNER_ADDRESS, 64\)/)
  assert.match(recipientRoute, /session\.address !== configuredOwner/)
  assert.match(recipientRoute, /private-owner-only-platform/)
  assert.match(recipientRoute, /private-platform-owner-not-configured/)
})

test('legacy Fincra payout submission is disabled even if old credentials remain configured', () => {
  const handler = recipientRoute.slice(
    recipientRoute.indexOf("router.post('/sponsor-requests/:id/fincra-payout'"),
    recipientRoute.indexOf("router.post('/sponsor-requests/:id/fincra-status'"),
  )
  assert.match(handler, /legacy-fincra-payout-disabled/)
  assert.match(handler, /return res\.status\(410\)/)
  assert.match(handler, /payoutSubmitted: false/)
  assert.doesNotMatch(handler, /fincraRequest\(config, '\/stablecoin\/payouts'/)
})

test('recipient inspection and TRON RPC require the configured owner session', () => {
  const recipientHandler = recipientRoute.slice(
    recipientRoute.indexOf("router.get('/recipient'"),
    recipientRoute.indexOf("router.post('/sponsor-requests'"),
  )
  const rpcHandler = recipientRoute.slice(
    recipientRoute.indexOf("router.all('/rpc/:network/*'"),
    recipientRoute.indexOf("router.post('/broadcast'"),
  )
  assert.match(recipientHandler, /requireOwnerSession\(req, env\)/)
  assert.match(rpcHandler, /requireOwnerSession\(req, env\)/)
  assert.match(recipientHandler, /no-store, private/)
})

test('the frontend shows an owner sign-in gate before rendering the dashboard', async () => {
  const app = await readFile(new URL('../Frontend-Tron-Transfer/src/App.jsx', import.meta.url), 'utf8')
  assert.match(app, /ownerSessionResolved/)
  assert.match(app, /if \(!ownerSession\) return/)
  assert.match(app, /Platform owner sign-in/)
  assert.match(app, /ownerSession\.sessionToken/)
  assert.match(app, /Authorization: 'Bearer ' \+ ownerSession\.sessionToken/)
})

test('provider readiness is private, read-only and fails closed without verified funding', () => {
  assert.match(recipientRoute, /router.get\('\/provider-readiness'/)
  assert.match(recipientRoute, /requireOwnerSession\(req, env\)/)
  assert.match(recipientRoute, /getUnconfiguredProviderPayoutReadiness\(\)/)
  assert.match(recipientRoute, /provider-owned USDT liquidity or an approved credit facility/)
  assert.match(recipientRoute, /readiness,/) 
})

test('runtime does not expose public sponsor registration, individual sponsor settlement or Fireblocks routes', () => {
  assert.doesNotMatch(entry, /sponsorRequestIntakeRoutes|createSponsorDirectPayoutsRouter|createSponsorOrganizationRouter/)
  assert.doesNotMatch(entry, /startSponsorDirectPayoutReconciliationWorker/)
  assert.doesNotMatch(entry, /treasuryWithdrawalsRoutes|fireblocksInventorySyncRoutes|fireblocksInventoryStatusRoutes/)
  assert.doesNotMatch(entry, /ownerSponsorLiquidityRoutes/)
})

test('private owner console uses provider readiness instead of sponsor or Fincra pages', async () => {
  const app = await readFile(new URL('../Frontend-Tron-Transfer/src/App.jsx', import.meta.url), 'utf8')
  const providerPage = await readFile(new URL('../Frontend-Tron-Transfer/src/ProviderPayoutReadiness.jsx', import.meta.url), 'utf8')
  assert.match(app, /ProviderPayoutReadiness/)
  assert.match(app, /id:'provider',label:'Funding provider'/)
  assert.doesNotMatch(app, /FincraWithdrawals|SponsorOrganizationOnboarding|tab==='sponsors'/)
  assert.match(providerPage, /provider-readiness/)
  assert.match(providerPage, /No approved payout funding source/)
  assert.match(providerPage, /provider-owned USDT liquidity/)
})

test('Fincra payout statuses remain conservative for historical reconciliation', () => {
  assert.equal(payoutStatusFromProvider('pending'), 'unknown')
  assert.equal(payoutStatusFromProvider('PENDING'), 'unknown')
  assert.equal(payoutStatusFromProvider('initiated'), 'unknown')
  assert.equal(payoutStatusFromProvider('processing'), 'processing')
  assert.equal(payoutStatusFromProvider('successful'), 'successful')
  assert.equal(payoutStatusFromProvider('failed'), 'failed')
  assert.equal(payoutStatusFromProvider('unknown-provider-state'), 'unknown')
})
