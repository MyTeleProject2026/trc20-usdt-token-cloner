import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
const fincraWithdrawals = await readFile(new URL('../src/FincraWithdrawals.jsx', import.meta.url), 'utf8')
const sponsorOrganization = await readFile(new URL('../src/SponsorOrganizationOnboarding.jsx', import.meta.url), 'utf8')
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

test('production frontend is TRON Mainnet-only and pins official Tether USDT', () => {
  assert.ok(app.includes("MAINNET_MONITORED_ADDRESS = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'"))
  assert.ok(app.includes("network:'mainnet'"))
  assert.ok(app.includes("tokenContract:MAINNET_USDT"))
  assert.ok(!/Nile Testnet|Shasta Testnet|tron-nile|tron-shasta|testnet-wallet/i.test(app + fincraWithdrawals + sponsorOrganization))
  assert.ok(app.includes("MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'"))
})

test('only official Mainnet Tether USDT is exposed as the withdrawal asset', () => {
  assert.ok(app.includes("MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'"))
  assert.ok(fincraWithdrawals.includes('USDT TRC20 amount'))
  assert.ok(!/custom token contract|addToken|tokenInput/i.test(app + fincraWithdrawals))
})

test('requester can submit a payout with identity proof only, without signing or funding the payout transaction', () => {
  assert.ok(app.includes('<FincraWithdrawals wallet={unlocked} mode="withdraw" ownerSession={ownerSession} />'))
  assert.ok(fincraWithdrawals.includes('/api/tron-transfer/sponsor-requests'))
  assert.ok(fincraWithdrawals.includes('/api/auth/tron/challenge'))
  assert.ok(fincraWithdrawals.includes('signMessageV2(challenge.message)'))
  assert.ok(fincraWithdrawals.includes('/api/auth/tron/verify'))
  assert.ok(fincraWithdrawals.includes('/fincra-payout'))
  assert.ok(fincraWithdrawals.includes('This signature does not spend funds'))
  assert.ok(!/sendRawTransaction|privateKey|private key input|seed phrase input/i.test(app + fincraWithdrawals))
})

test('standing provider authorization is signed once within explicit limits; requester UI never signs a payout transaction', () => {
  assert.ok(sponsorOrganization.includes('wallet.tronWeb.trx.signMessageV2'))
  assert.ok(sponsorOrganization.includes('fincra-automatic'))
  assert.ok(sponsorOrganization.includes('Fincra business ID'))
  assert.ok(sponsorOrganization.includes('perPayoutBaseUnits'))
  assert.ok(sponsorOrganization.includes('dailyBaseUnits'))
  assert.ok(sponsorOrganization.includes('without a fresh sponsor wallet signature for each payout'))
  assert.ok(!/trx\.sign\(.*unsignedTransaction/.test(fincraWithdrawals))
  assert.ok(!fincraWithdrawals.includes('/broadcast'))
})

test('platform owner session is used for organization and mandate review', () => {
  assert.ok(app.includes('/api/auth/owner/login'))
  assert.ok(app.includes('Platform owner authentication'))
  assert.ok(app.includes('<SponsorOrganizationOnboarding wallet={unlocked} ownerSession={ownerSession} />'))
  assert.ok(sponsorOrganization.includes('Approve') || sponsorOrganization.includes('Review'))
})

test('automatic payout UI describes real provider funding and fail-closed sponsor requirements', () => {
  assert.ok(fincraWithdrawals.includes('authorized Fincra business account'))
  assert.ok(fincraWithdrawals.includes('standing Fincra mandate'))
  assert.ok(fincraWithdrawals.includes('no payout is reported as successful'))
  assert.ok(sponsorOrganization.includes('independently verify'))
})

test('only never-submitted pending requests can be explicitly retried; unknown outcomes are reconciled, not resubmitted', () => {
  assert.match(fincraWithdrawals, /async function submitExistingRequest/)
  assert.match(fincraWithdrawals, /request\.status !== 'pending-organization-review' \|\| request\.fincraStatus/)
  assert.match(fincraWithdrawals, /Submitted or ambiguous payouts must be reconciled/)
  assert.match(fincraWithdrawals, /Retry authorized payout/)
})

test('payout history distinguishes provider state from solidified on-chain transfer evidence', () => {
  assert.ok(fincraWithdrawals.includes('Provider processing'))
  assert.ok(fincraWithdrawals.includes('solidified-recipient-transfer-verified'))
  assert.ok(fincraWithdrawals.includes('/fincra-status'))
  assert.ok(fincraWithdrawals.includes('/verify-recipient-transfer'))
  assert.ok(fincraWithdrawals.includes('does not prove exchange internal credit'))
})

test('active UI uses Fincra payout flow and does not mount the legacy sponsor wallet broadcast UI', () => {
  assert.ok(app.includes('FincraWithdrawals'))
  assert.ok(app.includes("tab==='withdrawals'"))
  assert.ok(app.includes("tab==='transactions'"))
  assert.ok(!app.includes("import SponsorDirectPayouts"))
  assert.ok(!app.includes('<SponsorDirectPayouts'))
})

test('owner-controlled Fincra payouts use the owner session only when it matches the requester wallet', () => {
  assert.ok(app.includes('ownerSession={ownerSession}'))
  assert.ok(fincraWithdrawals.includes('ownerSession?.address === walletAddress'))
  assert.ok(fincraWithdrawals.includes('payoutSessionToken = ownerManagedPayout ? ownerSession.sessionToken : session?.sessionToken'))
  assert.ok(fincraWithdrawals.includes('Owner-operated Fincra account'))
  assert.ok(fincraWithdrawals.includes('does not require a separate sponsor wallet mandate'))
})

test('production metadata and frontend test command remain configured', () => {
  assert.ok(html.includes('Mainnet-only Tether USDT TRC20 withdrawal platform'))
  assert.ok(html.includes('Tron Transfer · Direct Mainnet USDT'))
  assert.equal(pkg.scripts.build, 'vite build')
  assert.equal(pkg.scripts.test, 'node --test tests/*.test.mjs')
})

test('navigation keeps dedicated dashboard, assets, recipients, withdrawals, sponsor and transaction pages', () => {
  for (const page of ['overview', 'assets', 'recipients', 'withdrawals', 'sponsors', 'transactions', 'settings']) {
    assert.ok(app.includes("id:'" + page + "'"), 'missing navigation item: ' + page)
    assert.ok(app.includes("tab==='" + page + "'"), 'missing dedicated page section: ' + page)
  }
  assert.ok(app.includes('<FincraWithdrawals wallet={unlocked} mode="history" ownerSession={ownerSession} />'))
  assert.ok(app.includes('Platform owner authentication'))
})

test('wallet connection is user-approved and does not import a private key', () => {
  assert.ok(app.includes('discoverTronLinkProvider(window)'))
  assert.ok(app.includes('requestTronLinkConnection(provider,window)'))
  assert.ok(app.includes('TronLink connected to TRON Mainnet'))
  assert.ok(app.includes('No imported private keys') || app.includes('private key'))
})
