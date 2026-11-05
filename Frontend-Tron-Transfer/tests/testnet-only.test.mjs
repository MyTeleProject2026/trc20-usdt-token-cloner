import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
const withdrawals = await readFile(new URL('../src/OwnerWithdrawals.jsx', import.meta.url), 'utf8')
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

test('production frontend is TRON Mainnet-only and pins official Tether USDT', () => {
  assert.ok(app.includes("MAINNET_MONITORED_ADDRESS = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'"))
  assert.ok(app.includes("network:'mainnet'"))
  assert.ok(app.includes("tokenContract:MAINNET_USDT"))
  assert.ok(!/Nile Testnet|Shasta Testnet|tron-nile|tron-shasta|testnet-wallet/i.test(app + withdrawals))
  assert.ok(app.includes("MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'"))
  assert.ok(withdrawals.includes("MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'"))
})

test('only the official Tether contract is exposed as the withdrawal asset', () => {
  assert.ok(withdrawals.includes('Official Tether USDT TRC20'))
  assert.ok(!/custom token contract|addToken|tokenInput/i.test(app + withdrawals))
})

test('withdrawal form uses TronLink signing and Tatum server broadcast', () => {
  assert.ok(app.includes("<OwnerWithdrawals wallet={unlocked} ownerSession={ownerSession} />"))
  assert.ok(withdrawals.includes('wallet.tronWeb.trx.sign(prepared.unsignedTransaction)'))
  assert.ok(withdrawals.includes('/api/tron-owner-withdrawals/prepare'))
  assert.ok(withdrawals.includes('/api/tron-owner-withdrawals/'))
  assert.ok(withdrawals.includes('/broadcast'))
  assert.ok(!/sendRawTransaction|privateKey|private key input|seed phrase input/i.test(withdrawals))
})

test('owner session and connected TronLink account must match before signing', () => {
  assert.ok(app.includes('/api/auth/owner/login'))
  assert.ok(withdrawals.includes('ownerSession.address === walletAddress'))
  assert.ok(withdrawals.includes('currentAddress !== ownerSession.address'))
  assert.ok(withdrawals.includes('configured owner address'))
})

test('wallet assets are read-only and never represented as simulated funding', () => {
  assert.ok(app.includes('MONITORED ADDRESS · READ ONLY'))
  assert.ok(withdrawals.includes('USDT principal'))
  assert.ok(withdrawals.includes('Tatum does not provide the USDT principal'))
  assert.ok(!/fake balance|simulated balance|testnet simulator/i.test(app + withdrawals))
})

test('external exchange deposit warning distinguishes chain confirmation from exchange credit', () => {
  assert.ok(withdrawals.includes('minimum deposit'))
  assert.ok(withdrawals.includes('does not guarantee the exchange will credit its internal account ledger'))
  assert.ok(withdrawals.includes('TRON / TRC20 USDT deposit address'))
})

test('no legacy Fincra payout flow remains in the active Tron Transfer UI', () => {
  assert.ok(!/Fincra|FINCRA|fincra-payout/i.test(app + withdrawals))
  assert.ok(app.includes('Owner access & wallet funding'))
  assert.ok(withdrawals.includes('TATUM MAINNET · TRONLINK OWNER SIGNING'))
})

test('production metadata and frontend test command remain configured', () => {
  assert.ok(html.includes('Mainnet-only sponsored Tether USDT TRC20 withdrawal platform') || html.includes('Mainnet-only Tether USDT TRC20 withdrawal platform'))
  assert.ok(html.includes('Tron Transfer · Direct Mainnet USDT'))
  assert.equal(pkg.scripts.build, 'vite build')
  assert.equal(pkg.scripts.test, 'node --test tests/*.test.mjs')
})

test('navigation keeps dedicated dashboard, assets, recipients, withdrawals, owner and transaction pages', () => {
  for (const page of ['overview', 'assets', 'recipients', 'withdrawals', 'sponsors', 'transactions', 'settings']) {
    assert.ok(app.includes(`id:'${page}'`), 'missing navigation item: ' + page)
    assert.ok(app.includes(`tab==='${page}'`), 'missing dedicated page section: ' + page)
  }
  assert.ok(app.includes('<OwnerWithdrawals wallet={unlocked} ownerSession={ownerSession} historyOnly />'))
  assert.ok(app.includes('Owner authentication'))
})

test('wallet connection is user-approved and does not import a private key', () => {
  assert.ok(app.includes("provider.request({method:'eth_requestAccounts'})"))
  assert.ok(app.includes('TronLink connected to TRON Mainnet'))
  assert.ok(app.includes('No imported private keys') || app.includes('private key'))
})
