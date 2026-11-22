import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const ui = await readFile(new URL('../src/SponsorWalletManager.jsx', import.meta.url), 'utf8')
const api = await readFile(new URL('../resource-api/server.js', import.meta.url), 'utf8')
const service = await readFile(new URL('../resource-api/sponsor-api.mjs', import.meta.url), 'utf8')

test('Sponsor Wallet no longer falls back to the separate Token Studio API', () => {
  assert.match(ui, /const RESOURCE_API =/)
  assert.doesNotMatch(ui, /trc20-usdt-token-cloner-api\.onrender\.com/)
  assert.doesNotMatch(ui, /VITE_API_BASE_URL/)
  assert.doesNotMatch(ui, /API_BASE/)
})

test('Sponsor password sessions authenticate and authorize exact backend-signed intents', () => {
  assert.match(ui, /createManagedWalletAuthClient\(\{ role: 'sponsor'/)
  assert.match(ui, /Sponsor Workspace Login/)
  assert.match(ui, /sponsorAuth\.login\(authPassword\)/)
  assert.match(ui, /credentials: 'include'/)
  assert.match(ui, /x-csrf-token/)
  assert.match(ui, /\/api\/sponsor\/intent/)
  assert.match(ui, /\/api\/sponsor\/operations/)
  assert.match(ui, /reconcileLastSponsorOperation/)
  assert.match(ui, /Reconcile last Sponsor operation/)
  assert.match(ui, /transactionExecutionAvailable !== true/)
  assert.match(ui, /confirmPhrase: intent\.confirmationPhrase/)
  assert.doesNotMatch(ui, /wallet\.privateKey/)
  assert.doesNotMatch(ui, /signMessageV2/)
  assert.doesNotMatch(ui, /trx\.sendRawTransaction/)
  assert.doesNotMatch(ui, /trx\.sign\(unsigned/)
})

test('Resource API mounts Sponsor routes and allows authenticated browser preflight', () => {
  assert.match(api, /createSponsorResourceApi/)
  assert.match(api, /sponsorApi\.handle\(req, res, url, origin\)/)
  assert.match(api, /content-type, authorization/)
})

test('Sponsor server supports managed password sessions and legacy signed sessions with durable idempotency', () => {
  assert.match(service, /SPONSOR_SESSION_SECRET/)
  assert.match(service, /idempotency_key_hash/)
  assert.match(service, /intentMessage/)
  assert.match(service, /verifyMessage\(intent\.message, body\.signature\)/)
  assert.match(service, /if \(!managedSessionAuth\)/)
  assert.match(service, /explicit-confirmation-and-authentication-required/)
  assert.match(service, /durable-idempotency-storage-required/)
  assert.match(service, /onSigned: async transactionId/)
})
