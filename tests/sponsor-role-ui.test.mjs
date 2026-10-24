import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const app = await readFile(new URL('../src/WorkflowApp.tsx', import.meta.url), 'utf8')
const roleReader = await readFile(new URL('../server/sponsor-roles.mjs', import.meta.url), 'utf8')

test('staged workflow loads separate fee and principal sponsor roles from the backend', () => {
  assert.ok(app.includes('/api/tron/sponsorship/roles?network='))
  assert.ok(app.includes('networkFeeSponsor'))
  assert.ok(app.includes('assetPrincipalSponsor'))
  assert.ok(app.includes('Network fee sponsor'))
  assert.ok(app.includes('Asset principal sponsor'))
  assert.ok(app.includes('Verified on-chain TRX balance'))
  assert.ok(app.includes("role?.native?.status === 'verified'"))
  assert.ok(app.includes("token.status === 'verified'"))
  assert.ok(app.includes('Available Energy'))
  assert.ok(app.includes('Provider snapshot only'))
  assert.ok(app.includes('does not prove the sponsor is funded'))
})

test('sponsor role snapshots never enable transfer submission by themselves', () => {
  assert.ok(app.includes('Sponsored transfer submission is blocked by the backend'))
  assert.ok(app.includes('Sponsored transfer unavailable'))
  assert.ok(app.includes('No sender-funded fallback'))
  assert.ok(roleReader.includes('canSubmitSponsoredTransfer: false'))
  assert.ok(roleReader.includes('resourceRead'))
  assert.ok(roleReader.includes('submissionEnabled: false'))
  assert.ok(roleReader.includes('No user-funded fallback is permitted'))
})
