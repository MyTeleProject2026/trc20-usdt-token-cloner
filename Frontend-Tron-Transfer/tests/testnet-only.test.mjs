import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
const sponsorPayouts = await readFile(new URL('../src/SponsorDirectPayouts.jsx', import.meta.url), 'utf8')
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

test('production frontend is TRON Mainnet-only and pins official Tether USDT', () => {
  assert.ok(app.includes("MAINNET_MONITORED_ADDRESS = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'"))
  assert.ok(app.includes("network:'mainnet'"))
  assert.ok(app.includes("tokenContract:MAINNET_USDT"))
  assert.ok(!/Nile Testnet|Shasta Testnet|tron-nile|tron-shasta|testnet-wallet/i.test(app + sponsorPayouts))
  assert.ok(app.includes("MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'"))
  assert.ok(sponsorPayouts.includes("MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'"))
})

test('only the official Tether contract is exposed as the withdrawal asset', () => {
  assert.ok(sponsorPayouts.includes('Official Tether USDT TRC20'))
  assert.ok(!/custom token contract|addToken|tokenInput/i.test(app + sponsorPayouts))
})

test('requester can submit sponsored withdrawals without signing or funding the payout transaction', () => {
  assert.ok(app.includes('<SponsorDirectPayouts wallet={unlocked} ownerSession={ownerSession} mode="withdraw" />'))
  assert.ok(sponsorPayouts.includes('/api/tron/sponsor-direct/requests'))
  assert.ok(sponsorPayouts.includes('/api/auth/tron/challenge'))
  assert.ok(sponsorPayouts.includes('signMessageV2(challenge.message)'))
  assert.ok(sponsorPayouts.includes('/api/auth/tron/verify'))
  assert.ok(sponsorPayouts.includes('Your wallet does not need USDT or TRX to submit a request'))
  assert.ok(!/sendRawTransaction|privateKey|private key input|seed phrase input/i.test(app + sponsorPayouts))
})

test('only the approved sponsor wallet signs and broadcasts its exact payout', () => {
  assert.ok(sponsorPayouts.includes('wallet.tronWeb.trx.sign(item.unsignedTransaction)'))
  assert.ok(sponsorPayouts.includes('walletAddress !== item.sponsorAddress'))
  assert.ok(sponsorPayouts.includes('/api/tron/sponsor-direct/requests/'))
  assert.ok(sponsorPayouts.includes('/broadcast'))
  assert.ok(sponsorPayouts.includes('Only the approved sponsor address that prepared this payment can sign it.'))
  assert.ok(sponsorPayouts.includes("The sponsor's own wallet sends and signs the USDT"))
})

test('platform owner session is used for sponsor application review, not as the payout signer', () => {
  assert.ok(app.includes('/api/auth/owner/login'))
  assert.ok(app.includes('Platform owner authentication'))
  assert.ok(sponsorPayouts.includes('/api/tron/sponsor-direct/applications'))
  assert.ok(sponsorPayouts.includes('Approve wallet participation'))
  assert.ok(sponsorPayouts.includes('complianceVerified: false') || sponsorPayouts.includes('does not constitute legal-entity verification'))
})

test('sponsor readiness uses actual on-chain balances, resources and bounded budgets', () => {
  assert.ok(sponsorPayouts.includes('Actual sponsor USDT'))
  assert.ok(sponsorPayouts.includes('Available Energy'))
  assert.ok(sponsorPayouts.includes('Available Bandwidth'))
  assert.ok(sponsorPayouts.includes('Daily payout remaining'))
  assert.ok(sponsorPayouts.includes('The balance shown belongs to the connected sponsor wallet'))
})

test('payout history distinguishes on-chain confirmation from exchange account credit', () => {
  assert.ok(sponsorPayouts.includes('View on TRONSCAN'))
  assert.ok(sponsorPayouts.includes('on-chain transfer is not exchange credit'))
  assert.ok(sponsorPayouts.includes('does not prove that an exchange credited the deposit'))
  assert.ok(sponsorPayouts.includes('minimum deposit'))
})

test('no legacy Fincra payout flow remains in the active Tron Transfer UI', () => {
  assert.ok(!/Fincra|FINCRA|fincra-payout/i.test(app + sponsorPayouts))
  assert.ok(app.includes('Sponsors & approvals'))
  assert.ok(sponsorPayouts.includes('TATUM MAINNET · SPONSOR-DIRECT USDT'))
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
  assert.ok(app.includes('<SponsorDirectPayouts wallet={unlocked} ownerSession={ownerSession} mode="history" />'))
  assert.ok(app.includes('Platform owner authentication'))
})

test('wallet connection is user-approved and does not import a private key', () => {
  assert.ok(app.includes('discoverTronLinkProvider(window)'))
  assert.ok(app.includes('requestTronLinkConnection(provider,window)'))
  assert.ok(app.includes('TronLink connected to TRON Mainnet'))
  assert.ok(app.includes('No imported private keys') || app.includes('private key'))
})
