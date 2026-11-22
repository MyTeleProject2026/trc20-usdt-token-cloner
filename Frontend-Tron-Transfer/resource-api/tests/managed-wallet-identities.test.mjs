import test from 'node:test'
import assert from 'node:assert/strict'
import { createManagedWalletIdentityReport } from '../managed-wallet-identities.mjs'

const OWNER = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const SPONSOR = 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL'
const OWNER_KEY = '1'.repeat(64)
const SPONSOR_KEY = '2'.repeat(64)

function fixture(overrides = {}) {
  return {
    TRON_OWNER_PRIVATE_KEY: OWNER_KEY,
    TRON_OWNER_ADDRESS: OWNER,
    SPONSOR_MAINNET_PRIVATE_KEY: SPONSOR_KEY,
    SPONSOR_MAINNET_ADDRESS: SPONSOR,
    ...overrides,
  }
}

test('derives and matches separate Owner and Sponsor identities without returning private keys', () => {
  const report = createManagedWalletIdentityReport({
    env: fixture(),
    deriveAddress: key => key === OWNER_KEY ? OWNER : SPONSOR,
  })
  assert.equal(report.owner.addressMatches, true)
  assert.equal(report.sponsor.addressMatches, true)
  assert.equal(report.identitiesDistinct, true)
  assert.equal(report.ready, true)
  assert.equal(report.executionEnabled, false)
  assert.equal(JSON.stringify(report).includes(OWNER_KEY), false)
  assert.equal(JSON.stringify(report).includes(SPONSOR_KEY), false)
})

test('fails closed when Owner private key is absent', () => {
  const report = createManagedWalletIdentityReport({
    env: fixture({ TRON_OWNER_PRIVATE_KEY: '' }),
    deriveAddress: key => key === SPONSOR_KEY ? SPONSOR : null,
  })
  assert.equal(report.owner.configured, false)
  assert.equal(report.owner.ready, false)
  assert.equal(report.ready, false)
  assert.equal(report.executionEnabled, false)
})

test('fails closed when a configured address does not match its private key', () => {
  const report = createManagedWalletIdentityReport({
    env: fixture(),
    deriveAddress: key => key === OWNER_KEY ? SPONSOR : OWNER,
  })
  assert.equal(report.owner.addressMatches, false)
  assert.equal(report.sponsor.addressMatches, false)
  assert.equal(report.ready, false)
})

test('fails closed when Owner and Sponsor resolve to the same identity', () => {
  const report = createManagedWalletIdentityReport({
    env: fixture({ SPONSOR_MAINNET_ADDRESS: OWNER }),
    deriveAddress: () => OWNER,
  })
  assert.equal(report.identitiesDistinct, false)
  assert.equal(report.ready, false)
})

test('rejects malformed private-key configuration without disclosing its value', () => {
  const secret = 'not-a-valid-private-key'
  assert.throws(
    () => createManagedWalletIdentityReport({ env: fixture({ TRON_OWNER_PRIVATE_KEY: secret }) }),
    error => error.message === 'TRON_OWNER_PRIVATE_KEY-invalid-format' && !error.message.includes(secret),
  )
})
