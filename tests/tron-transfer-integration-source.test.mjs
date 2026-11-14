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

test('TRӾ manager is wallet-accessible and contract administration remains on-chain-owner-only', async () => {
  const app = await readFile(new URL('../Frontend-Tron-Transfer/src/App.jsx', import.meta.url), 'utf8')
  const panel = await readFile(new URL('../Frontend-Tron-Transfer/src/TRXMainnetPanel.jsx', import.meta.url), 'utf8')
  assert.match(app, /<TRXMainnetPanel wallet=\{unlocked\} onConnect=/)
  assert.doesNotMatch(app, /if \(!ownerSession\) return/)
  assert.doesNotMatch(app, /if \(!ownerSessionResolved\) return/)
  assert.match(panel, /Connect any TronLink wallet on TRON Mainnet/)
  assert.match(panel, /token\.owner\(\)\.call\(\)/)
  assert.match(panel, /addressesEqual\(tronWeb, owner, connectedAddress\)/)
  assert.match(panel, /addressesEqual\(tronWeb, vaultOwner, connectedAddress\)/)
})

test('provider readiness is private, performs only read-only Fincra diagnostics, and remains fail-closed', () => {
  assert.match(recipientRoute, /router.get\('\/provider-readiness'/)
  assert.match(recipientRoute, /requireOwnerSession\(req, env\)/)
  assert.match(recipientRoute, /readFincraAccountDiagnostics\(env\)/)
  assert.match(recipientRoute, /provider: \{ name: 'Fincra', selected: true \}/)
  assert.match(recipientRoute, /getUnconfiguredProviderPayoutReadiness\(\)/)
  assert.match(recipientRoute, /filter\(\(blocker\) => blocker !== 'no-provider-selected'\)/)
  assert.match(recipientRoute, /providerOwnedLiquidityVerified: false/)
  assert.match(recipientRoute, /providerApprovedCreditVerified: false/)
  assert.match(recipientRoute, /payoutSubmissionEnabled: false/)
  assert.match(recipientRoute, /transactionSubmitted: false/)
  assert.match(recipientRoute, /sponsorBusinessBalanceIsSponsorOwnedAccountFunds: true/)
  assert.match(recipientRoute, /sponsor-standing-fincra-mandate-not-independently-authorized/)
  assert.match(recipientRoute, /production-payout-and-chain-reconciliation-not-enabled/)
})

test('runtime mounts the private owner-only Mainnet sponsor-direct payout flow and reconciliation worker', () => {
  assert.ok(entry.includes('createSponsorDirectPayoutsRouter'))
  assert.ok(entry.includes("app.use('/api/tron/sponsor-direct', createSponsorDirectPayoutsRouter())"))
  assert.ok(entry.includes('startSponsorDirectPayoutReconciliationWorker({ env: process.env })'))
  assert.doesNotMatch(entry, /createSponsorOrganizationRouter|treasuryWithdrawalsRoutes|fireblocksInventorySyncRoutes|fireblocksInventoryStatusRoutes/)
  assert.doesNotMatch(entry, /ownerSponsorLiquidityRoutes/)

  const requestIntake = sponsorRoute.slice(
    sponsorRoute.indexOf("router.post('/requests'"),
    sponsorRoute.indexOf("router.get('/my-requests'"),
  )
  assert.ok(requestIntake.includes('requirePlatformOwner(req, env, getSession, now)'))
  assert.ok(!requestIntake.includes('requireWalletSession(req, env, getSession, now)'))
  assert.ok(sponsorRoute.includes('sponsorWalletSignatureRequired: true'))
  assert.ok(sponsorRoute.includes("payoutExecution: 'conditional-on-approved-funded-sponsor'"))
  assert.ok(sponsorRoute.includes('verifySponsorDirectMainnetTransfer'))
  assert.ok(sponsorFrontend.includes('wallet.tronWeb.trx.sign(item.unsignedTransaction)'))
  assert.ok(sponsorFrontend.includes('/broadcast'))
})

test('TRӾ Mainnet manager remains scoped to the requested smart-contract panel', async () => {
  const app = await readFile(new URL('../Frontend-Tron-Transfer/src/App.jsx', import.meta.url), 'utf8')
  const panel = await readFile(new URL('../Frontend-Tron-Transfer/src/TRXMainnetPanel.jsx', import.meta.url), 'utf8')
  assert.match(app, /<TRXMainnetPanel wallet=\{unlocked\} onConnect=/)
  assert.match(app, /TRӾ smart-contract manager/)
  assert.match(panel, /Deploy both contracts · two TronLink approvals/)
  assert.match(panel, /On-chain verification/)
  assert.match(panel, /mintingEnabled/)
  assert.doesNotMatch(app, /SponsorDirectPayouts|ProviderPayoutReadiness/)
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


const fincraWebhookRoute = await readFile(new URL('../server/routes/fincra-webhook.mjs', import.meta.url), 'utf8')

test('Fincra signed payout webhook is mounted before the disabled legacy handler and never confirms chain settlement', () => {
  const webhookMount = entry.indexOf("app.use('/api/tron-transfer', createFincraWebhookRouter())")
  const legacyMount = entry.indexOf("app.use('/api/tron-transfer', tronTransferRoutes)")
  assert.ok(webhookMount >= 0 && legacyMount > webhookMount)
  assert.match(entry, /express\.raw\(\{ type: 'application\/json'/)
  assert.match(fincraWebhookRoute, /verifyFincraWebhookSignature/)
  assert.match(fincraWebhookRoute, /ON CONFLICT \(event_digest\) DO NOTHING/)
  assert.match(fincraWebhookRoute, /fincra_status=\$3/)
  assert.match(fincraWebhookRoute, /chainSettlement: 'not-verified'/)
  assert.doesNotMatch(fincraWebhookRoute, /wallet\/broadcasttransaction|sendRawTransaction/i)
})
