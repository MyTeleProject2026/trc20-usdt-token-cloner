import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

test('production frontend is Mainnet-only and defaults to the monitored wallet', () => {
  assert.ok(app.includes("MAINNET_MONITORED_ADDRESS = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'"))
  assert.ok(app.includes("network:'mainnet'"))
  assert.ok(app.includes("tokenContract:MAINNET_USDT"))
  assert.ok(!/Nile Testnet|Shasta Testnet|tron-nile|tron-shasta|testnet-wallet/i.test(app))
  assert.ok(app.includes("MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'"))
})

test('only official USDT is represented as the payout asset', () => {
  assert.ok(app.includes('USDT withdrawal amount'))
  assert.ok(app.includes('Official Tether USDT TRC20'))
  assert.ok(!/addToken|tokenInput|custom token contract/i.test(app))
})

test('no direct wallet send or simulator path is present in the frontend', () => {
  assert.ok(!/buildSignAndBroadcastTransfer|sendRawTransaction|testnet simulator|Send testnet assets/i.test(app))
  assert.ok(app.includes('Tatum-only Mainnet architecture'))
  assert.ok(app.includes('fincra-payout'))
})

test('withdrawal screen uses off-chain TronLink Mainnet identity verification but does not create sponsor requests', () => {
  assert.ok(app.includes('signMessageV2'))
  assert.ok(app.includes('This identity signature is not a transaction and authorizes no funds.'))
  assert.ok(!app.includes('/api/tron-transfer/sponsor-requests'))
  assert.ok(app.includes('requesterSession.sessionToken'))
})

test('production metadata and frontend test command are configured', () => {
  assert.ok(html.includes('Mainnet-only sponsored Tether USDT TRC20 withdrawal platform'))
  assert.ok(html.includes('Tron Transfer · Mainnet USDT Payouts'))
  assert.equal(pkg.scripts.build, 'vite build')
  assert.equal(pkg.scripts.test, 'node --test tests/*.test.mjs')
})

test('production pages are separated into dedicated navigation and render sections', () => {
  for (const page of ['overview', 'assets', 'recipients', 'withdrawals', 'sponsors', 'transactions', 'settings']) {
    assert.ok(app.includes(`id:'${page}'`), `missing navigation item: ${page}`)
    assert.ok(app.includes(`tab==='${page}'`), `missing dedicated page section: ${page}`)
  }
  assert.ok(app.includes('Request a genuine USDT withdrawal'))
  assert.ok(app.includes('Sponsor funding & payout operations'))
  assert.ok(app.includes('Withdrawal transaction history'))
  assert.ok(app.includes('Tron Transfer settings'))
})

test('Assets page keeps personal wallet balances separate from Fincra sponsor liquidity', () => {
  assert.ok(app.includes('MONITORED ADDRESS · NOT PAYOUT FUNDING'))
  assert.ok(app.includes('AUTHORIZED FINCRA SOURCE · PAYOUT FUNDING'))
  assert.ok(app.includes('This is the Fincra source-wallet availability only. Your monitored wallet balance is not included'))
  assert.ok(app.includes('readiness.fincra.sourceBalance.availableBalance'))
})

test('new production page layouts have responsive styling', async () => {
  const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8')
  assert.ok(css.includes('.asset-source-grid'))
  assert.ok(css.includes('.withdrawal-form-grid'))
  assert.ok(css.includes('.transaction-row'))
  assert.ok(css.includes('.settings-page'))
  assert.ok(css.includes('@media(max-width:560px)'))
})

test('Sponsor funding page provides the Fincra USDT wallet number for authorized incoming sponsor transfers', () => {
  assert.ok(app.includes('SPONSOR FUNDING DESTINATION · FINCRA USDT BALANCE'))
  assert.ok(app.includes('account-to-account transfer only if Fincra enables transfers between both businesses’ USDT balances'))
  assert.ok(app.includes('confirm USDT wallet-to-wallet eligibility with Fincra before relying on this route'))
  assert.ok(app.includes('Fincra documents no webhook for account-to-account transfers'))
  assert.ok(app.includes('use Refresh readiness to confirm the credit from the actual available USDT balance'))
  assert.ok(app.includes('readiness.fincra.sourceBalance.walletNumber'))
  assert.ok(app.includes('Fincra USDT wallet number copied.'))
})

test('Assets page displays the verified Fincra USDT funding wallet number without combining it with monitored wallet assets', () => {
  assert.ok(app.includes('Fincra USDT funding wallet number:'))
  assert.ok(app.includes('MONITORED ADDRESS · NOT PAYOUT FUNDING'))
  assert.ok(app.includes('AUTHORIZED FINCRA SOURCE · PAYOUT FUNDING'))
})

test('Sponsor funding page loads and displays read-only Fincra business wallet credits', () => {
  assert.ok(app.includes('FINCRA BUSINESS BALANCE LEDGER'))
  assert.ok(app.includes('Incoming sponsor credits'))
  assert.ok(app.includes('/api/tron-transfer/sponsor-funding-history'))
  assert.ok(app.includes('Refresh funding history'))
  assert.ok(app.includes('Provider ledger records, not manually entered sponsor claims'))
})

test('Assets page shows available, locked and ledger total sponsor balances as separate values', () => {
  assert.ok(app.includes('Available · payout eligible'))
  assert.ok(app.includes('Locked'))
  assert.ok(app.includes('Ledger · total'))
  assert.ok(app.includes('FINCRA SPONSOR LEDGER · TOTAL SOURCE ASSETS'))
  assert.ok(app.includes('Only the separately displayed available balance is eligible to fund a new payout'))
})

test('withdrawal transaction pages distinguish requested gross amount from Fincra net recipient receipt and fees', () => {
  assert.ok(app.includes('Recipient received:'))
  assert.ok(app.includes('Sponsor charged:'))
  assert.ok(app.includes('Fee:'))
  assert.ok(app.includes('Net recipient amount:'))
  assert.ok(app.includes('Fincra fee:'))
  assert.ok(app.includes('fincraAmountReceivedBaseUnits'))
  assert.ok(app.includes('fincraAmountChargedBaseUnits'))
  assert.ok(app.includes('fincraFeeBaseUnits'))
})
