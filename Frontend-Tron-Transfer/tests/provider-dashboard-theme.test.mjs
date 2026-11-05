import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8')

test('recipient inspection uses Mainnet API and live withdrawal submission stays gated', () => {
  assert.ok(app.includes('/api/tron-transfer/recipient'))
  assert.ok(app.includes("network:'mainnet'"))
  assert.ok(app.includes('Tatum-only withdrawal preparation pending'))
  assert.ok(!app.includes('async function submitSponsorRequest'))
  assert.ok(app.includes("api('/api/tron-transfer/sponsor-requests',{headers:{Authorization:'Bearer '+token}})"))
  assert.ok(!app.includes('/api/tron-transfer/broadcast'))
  assert.ok(!app.includes('wallet/broadcasttransaction'))
})

test('recipient monitor defaults to the public monitored address and official Tether contract', () => {
  assert.ok(app.includes('TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'))
  assert.ok(app.includes('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'))
  assert.ok(app.includes('TRON Mainnet'))
})

test('legacy Fincra reconciliation is read-only and payout submission is disabled', () => {
  assert.ok(app.includes('canSubmitLivePayout'))
  assert.ok(app.includes('Fincra payout disabled'))
  assert.ok(app.includes("action==='fincra-payout'"))
  assert.ok(app.includes('fincra-status'))
  assert.ok(app.includes('verify-recipient-transfer'))
  assert.ok(!app.includes('canSubmitSandboxPayout'))
  assert.ok(!app.includes('Sandbox payout'))
})

test('requester identity and payout owner sessions are separate', () => {
  assert.ok(app.includes('signMessageV2'))
  assert.ok(app.includes('/api/auth/tron/challenge'))
  assert.ok(app.includes('/api/auth/tron/verify'))
  assert.ok(app.includes('REQUESTER_SESSION_KEY'))
  assert.ok(app.includes('OWNER_SESSION_KEY'))
})

test('Tatum-only withdrawal preparation keeps recipient inspection tied to the selected address', () => {
  assert.ok(app.includes('inspectRequestRecipient'))
  assert.ok(app.includes('requestInspection&&requestInspection.address===requestRecipient.trim()'))
  assert.ok(app.includes('Recheck after five minutes or whenever the address changes'))
  assert.ok(app.includes('Inspect recipient balance & history'))
  assert.ok(app.includes('Tatum-only withdrawal preparation pending'))
})

test('forest emerald glass theme and responsive breakpoints remain', () => {
  assert.ok(css.includes('--bg: #07100d'))
  assert.ok(css.includes('--mint-bright: #65dfa1'))
  assert.ok(css.includes('backdrop-filter: blur'))
  assert.ok(css.includes('@media (max-width: 820px)'))
  assert.ok(css.includes('@media (max-width: 560px)'))
  assert.ok(css.includes('.sponsor-request-layout'))
})
