import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const page = await readFile(new URL('../src/SponsorProviderPages.tsx', import.meta.url), 'utf8')
const roleReader = await readFile(new URL('../server/sponsor-roles.mjs', import.meta.url), 'utf8')

test('sponsor provider page loads separate fee and principal sponsor accounts from the backend', () => {
  assert.ok(page.includes('/api/tron/sponsorship/roles?network='))
  assert.ok(page.includes('Sponsor A · Network fees / resources'))
  assert.ok(page.includes('Sponsor B · Asset principal'))
  assert.ok(page.includes('configuredAddressesDistinct'))
  assert.ok(page.includes('Legacy shared sponsor address snapshot'))
})

test('sponsor role UI shows verified values only and never treats a snapshot as transfer permission', () => {
  assert.ok(page.includes("fee.native?.status === 'verified'"))
  assert.ok(page.includes("asset.native?.status === 'verified'"))
  assert.ok(page.includes("token.status === 'verified'"))
  assert.ok(page.includes('Transfer submission remains disabled'))
  assert.ok(page.includes('No receiver credit is inferred'))
  assert.ok(roleReader.includes('canSubmitSponsoredTransfer: false'))
  assert.ok(roleReader.includes('submissionEnabled: false'))
  assert.ok(roleReader.includes('No user-funded fallback is permitted'))
})
