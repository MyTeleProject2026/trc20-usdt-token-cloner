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
  assert.ok(app.includes('USDT amount'))
  assert.ok(app.includes('Official Tether USDT TRC20'))
  assert.ok(!/addToken|tokenInput|custom token contract/i.test(app))
})

test('no direct wallet send or simulator path is present in the frontend', () => {
  assert.ok(!/buildSignAndBroadcastTransfer|sendRawTransaction|testnet simulator|Send testnet assets/i.test(app))
  assert.ok(app.includes('Mainnet-only sponsored withdrawals'))
  assert.ok(app.includes('fincra-payout'))
})

test('sponsor request uses off-chain Mainnet wallet ownership verification', () => {
  assert.ok(app.includes('signMessageV2'))
  assert.ok(app.includes('does not require TRX'))
  assert.ok(app.includes('/api/tron-transfer/sponsor-requests'))
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
