import test from 'node:test'
import assert from 'node:assert/strict'
import { getSponsorshipStatus } from '../server/sponsorship-status.mjs'

test('sponsorship is fail-closed without an integrated and verified provider', () => {
  const status = getSponsorshipStatus()
  assert.equal(status.enabled, false)
  assert.equal(status.mainnetEnabled, false)
  assert.equal(status.canSubmitSponsoredTransfer, false)
  assert.equal(status.provider, null)
  assert.equal(status.status, 'not-integrated')
})

test('environment flags cannot falsely enable sponsorship', () => {
  const original = {
    SPONSORSHIP_ENABLED: process.env.SPONSORSHIP_ENABLED,
    SPONSOR_PROVIDER: process.env.SPONSOR_PROVIDER,
    MAINNET_SPONSORSHIP_ENABLED: process.env.MAINNET_SPONSORSHIP_ENABLED,
  }
  try {
    process.env.SPONSORSHIP_ENABLED = 'true'
    process.env.SPONSOR_PROVIDER = 'claimed-provider'
    process.env.MAINNET_SPONSORSHIP_ENABLED = 'true'
    const status = getSponsorshipStatus()
    assert.equal(status.enabled, false)
    assert.equal(status.mainnetEnabled, false)
    assert.equal(status.canSubmitSponsoredTransfer, false)
    assert.equal(status.provider, null)
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
