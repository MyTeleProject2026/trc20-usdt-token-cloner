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
  assert.ok(withdrawals.includes('const isOwnerWallet = Boolean(ownerSession?.address && walletAddress && ownerSession.address === walletAddress)'))
  assert.ok(withdrawals.includes('const canInteract = Boolean(token && isOwnerWallet && wallet?.tronWeb?.trx)'))
  assert.ok(withdrawals.includes('The connected TronLink address does not match the configured owner address.'))
  assert.ok(withdrawals.includes('Owner wallet and owner session match.'))
  assert.ok(!withdrawals.includes('function signAndBroadcast'))
  assert.ok(!withdrawals.includes('wallet.tronWeb.trx.sign('))
})

test('forest emerald glass theme and responsive breakpoints remain', () => {
  assert.ok(css.includes('--bg: #07100d'))
  assert.ok(css.includes('--mint-bright: #65dfa1'))
  assert.ok(css.includes('backdrop-filter: blur'))
  assert.ok(css.includes('@media (max-width: 820px)'))
  assert.ok(css.includes('@media (max-width: 560px)'))
  assert.ok(css.includes('.owner-withdrawals-page'))
})
