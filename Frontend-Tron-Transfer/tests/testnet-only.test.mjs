import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
const providerPage = await readFile(new URL('../src/ProviderPayoutReadiness.jsx', import.meta.url), 'utf8')
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

test('production frontend is TRON Mainnet-only and pins official Tether USDT', () => {
  assert.ok(app.includes("MAINNET_MONITORED_ADDRESS = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'"))
  assert.ok(app.includes("network:'mainnet'"))
  assert.ok(app.includes("tokenContract:MAINNET_USDT"))
  assert.ok(!/Nile Testnet|Shasta Testnet|tron-nile|tron-shasta|testnet-wallet/i.test(app + providerPage))
  assert.ok(app.includes("MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'"))
})

test('only official Mainnet Tether USDT is exposed as the payout asset', () => {
  assert.ok(app.includes("MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'"))
  assert.ok(providerPage.includes('USDT TRC20'))
  assert.ok(!/custom token contract|addToken|tokenInput/i.test(app + providerPage))
})

test('the entire dashboard is gated by the configured platform-owner session', () => {
  assert.ok(app.includes('ownerSessionResolved'))
  assert.ok(app.includes('if (!ownerSession) return'))
  assert.ok(app.includes('Platform owner sign-in'))
  assert.ok(app.includes('/api/auth/owner/login'))
  assert.ok(app.includes('/api/auth/owner/session'))
  assert.ok(app.includes("Authorization: 'Bearer ' + ownerSession.sessionToken"))
})

test('private owner dashboard has no public sponsor or legacy Fincra payout UI', () => {
  assert.ok(app.includes("id:'provider',label:'Funding provider'"))
  assert.ok(app.includes("tab==='provider'"))
  assert.ok(app.includes('<ProviderPayoutReadiness ownerSession={ownerSession} mode="withdraw" />'))
  assert.ok(!/FincraWithdrawals|SponsorOrganizationOnboarding|SponsorDirectPayouts|tab==='sponsors'/.test(app))
})

test('provider payout readiness never claims execution without verified provider liquidity or credit', () => {
  assert.ok(providerPage.includes('/api/tron-transfer/provider-readiness'))
  assert.ok(providerPage.includes('No approved payout funding source'))
  assert.ok(providerPage.includes('provider-owned USDT liquidity'))
  assert.ok(providerPage.includes('approved credit facility'))
  assert.ok(providerPage.includes('Real payout execution'))
  assert.ok(providerPage.includes('Disabled'))
  assert.ok(!/submitRequest|sendRawTransaction|\/fincra-payout|\/broadcast/.test(providerPage))
})

test('the owner is not required to deposit or fund payouts from the identity wallet', () => {
  assert.ok(providerPage.includes('Your deposit required'))
  assert.ok(providerPage.includes('ownerDepositRequired'))
  assert.ok(providerPage.includes('ownerWalletPrincipalRequired'))
  assert.ok(providerPage.includes('not treated as the source of payout funds'))
})

test('navigation contains only private owner dashboard pages and a provider readiness page', () => {
  for (const page of ['overview', 'assets', 'recipients', 'withdrawals', 'provider', 'transactions', 'settings']) {
    assert.ok(app.includes("id:'" + page + "'"), 'missing navigation item: ' + page)
    assert.ok(app.includes("tab==='" + page + "'"), 'missing dedicated page section: ' + page)
  }
  assert.ok(!app.includes("id:'sponsors'"))
  assert.ok(!app.includes("tab==='sponsors'"))
})

test('wallet connection remains user-approved and never imports a private key', () => {
  assert.ok(app.includes('discoverTronLinkProvider(window)'))
  assert.ok(app.includes('requestTronLinkConnection(provider,window)'))
  assert.ok(app.includes('TronLink connected to TRON Mainnet'))
  assert.ok(app.includes('No imported private keys') || app.includes('private key'))
  assert.ok(!/sendRawTransaction|privateKey\s*[:=]/i.test(app + providerPage))
})

test('owner can close the private session and leave the application locked', () => {
  assert.ok(app.includes('function signOutOwner()'))
  assert.ok(app.includes('setOwnerSession(null)'))
  assert.ok(app.includes('onClick={signOutOwner}'))
})

test('production metadata and frontend test command remain configured', () => {
  assert.ok(html.includes('Mainnet-only Tether USDT TRC20 withdrawal platform'))
  assert.ok(html.includes('Tron Transfer · Direct Mainnet USDT'))
  assert.equal(pkg.scripts.build, 'vite build')
  assert.equal(pkg.scripts.test, 'node --test tests/*.test.mjs')
})
