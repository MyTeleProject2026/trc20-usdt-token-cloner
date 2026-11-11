import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
const withdrawals = await readFile(new URL('../src/OwnerWithdrawals.jsx', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8')

test('recipient inspection uses the read-only Mainnet API path', () => {
  assert.ok(app.includes('/api/tron-transfer/recipient'))
  assert.ok(app.includes("network:'mainnet'"))
  assert.ok(!app.includes('/api/tron-transfer/sponsor-requests'))
  assert.ok(!app.includes('/api/tron-transfer/broadcast'))
})

test('recipient monitor defaults to the public monitored address and official Tether contract', () => {
  assert.ok(app.includes('TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'))
  assert.ok(app.includes('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'))
  assert.ok(app.includes('TRON Mainnet'))
})

test('direct withdrawal panel reads balances and status using Tatum owner endpoints', () => {
  assert.ok(withdrawals.includes('/api/tron-owner-withdrawals/readiness'))
  assert.ok(withdrawals.includes('/api/tron-owner-withdrawals/prepare'))
  assert.ok(withdrawals.includes('/api/tron-owner-withdrawals/'))
  assert.ok(withdrawals.includes('Tatum Mainnet'))
  assert.ok(!withdrawals.includes('Fincra'))
})

test('owner session is restored and used independently from TronLink account connection', () => {
  assert.ok(app.includes('/api/auth/owner/session'))
  assert.ok(app.includes('/api/auth/owner/login'))
  assert.ok(app.includes('OWNER_SESSION_KEY'))
  assert.ok(app.includes('requestTronLinkConnection(provider,window)'))
  assert.ok(app.includes('/api/auth/owner/login'))
  assert.ok(withdrawals.includes('ownerSession.address === walletAddress'))
})

test('direct withdrawal requires a connected owner wallet matching the backend owner session', () => {
  assert.ok(withdrawals.includes('The connected TronLink address does not match the configured owner address.'))
  assert.ok(withdrawals.includes('currentAddress !== ownerSession.address'))
  assert.ok(withdrawals.includes('Owner wallet and owner session match.'))
})

test('forest emerald glass theme and responsive breakpoints remain', () => {
  assert.ok(css.includes('--bg: #07100d'))
  assert.ok(css.includes('--mint-bright: #65dfa1'))
  assert.ok(css.includes('backdrop-filter: blur'))
  assert.ok(css.includes('@media (max-width: 820px)'))
  assert.ok(css.includes('@media (max-width: 560px)'))
  assert.ok(css.includes('.owner-withdrawals-page'))
})


test('mobile navigation exposes the four primary owner tabs and a functional More menu', () => {
  assert.ok(app.includes("mobilePrimaryNav = nav.filter"))
  assert.ok(app.includes("['overview','assets','recipients','withdrawals']"))
  assert.ok(app.includes("mobileMoreNav = nav.filter"))
  assert.ok(app.includes("['provider','sponsors','transactions','settings']"))
  assert.ok(app.includes('aria-current={tab===item.id?\'page\':undefined}'))
  assert.ok(app.includes("setTab(item.id);setMoreOpen(false)"))
  assert.ok(app.includes("event.key === 'Escape'"))
  assert.ok(css.includes('.mobile-bottom-nav'))
  assert.ok(css.includes('.mobile-more-menu'))
  assert.ok(css.includes('env(safe-area-inset-bottom'))
})

test('mobile bottom navigation stays separate from owner authentication and wallet payout logic', () => {
  assert.ok(app.includes('className="app-shell auth-shell"'))
  assert.ok(app.includes('className="mobile-bottom-nav"'))
  assert.ok(app.includes('SponsorDirectPayouts wallet={unlocked} ownerSession={ownerSession} mode="withdraw"'))
  assert.ok(app.includes("requestTronLinkConnection(provider,window)"))
})
