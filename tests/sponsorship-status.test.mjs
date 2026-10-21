import test from 'node:test'
import assert from 'node:assert/strict'
import { getSponsorshipStatus } from '../server/sponsorship-status.mjs'

test('sponsorship fails closed until a provider and funding path are actually integrated', () => {
  const status = getSponsorshipStatus()
  assert.equal(status.enabled, false)
  assert.equal(status.status, 'not-integrated')
  assert.equal(status.provider, null)
  assert.equal(status.canSubmitSponsoredTransfer, false)
  assert.equal(status.mainnetEnabled, false)
  assert.equal(status.receiverRestrictionsAvailable, false)
  assert.match(status.message, /No verified sponsor provider is connected/)
  assert.match(status.message, /cannot impose spend restrictions on the receiver wallet/)
  assert.match(status.message, /audited escrow\/vesting contract/)
})
