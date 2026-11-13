import test from 'node:test'
import assert from 'node:assert/strict'
import { getTronMetaRelayerReadiness } from '../server/tron-meta-relayer-readiness.mjs'

const validAddress = 'TKmwZgALZPatKVJpcAx93XVNu6DiaauPFk'

test('meta-relayer is blocked when no sponsor wallet exists', () => {
  const result = getTronMetaRelayerReadiness({})
  assert.equal(result.network, 'TRON Mainnet')
  assert.equal(result.mode, 'readiness-only')
  assert.equal(result.submissionEnabled, false)
  assert.equal(result.transactionBroadcastingAvailable, false)
  assert.ok(result.blockers.includes('sponsor-wallet-required'))
  assert.ok(result.blockers.includes('live-relay-execution-is-not-implemented'))
})

test('environment flags and addresses cannot enable broadcasting without verified contracts and signer', () => {
  const result = getTronMetaRelayerReadiness({
    TRON_META_RELAYER_SPONSOR_ADDRESS: validAddress,
    TRON_META_RELAYER_FORWARDER_ADDRESS: validAddress,
    TRON_META_RELAYER_TOKEN_ADDRESS: validAddress,
    TRON_META_RELAYER_VAULT_ADDRESS: validAddress,
    TRON_META_RELAYER_ENABLED: 'true',
    TRON_META_RELAYER_PRIVATE_KEY: 'must-never-be-read',
  })
  assert.equal(result.checks.sponsorWalletAddressConfigured, true)
  assert.equal(result.checks.trustedForwarderAddressConfigured, true)
  assert.equal(result.checks.explicitFeatureOptIn, true)
  assert.equal(result.checks.onChainForwarderCodeVerified, false)
  assert.equal(result.checks.recipientMetaTxSupportVerified, false)
  assert.equal(result.checks.isolatedSponsorSignerAvailable, false)
  assert.equal(result.checks.sponsorFundingVerified, false)
  assert.equal(result.submissionEnabled, false)
  assert.equal(result.transactionBroadcastingAvailable, false)
  assert.equal(JSON.stringify(result).includes('must-never-be-read'), false)
})

test('invalid sponsor and contract addresses remain blocked', () => {
  const result = getTronMetaRelayerReadiness({
    TRON_META_RELAYER_SPONSOR_ADDRESS: 'not-a-tron-address',
    TRON_META_RELAYER_FORWARDER_ADDRESS: 'T123',
    TRON_META_RELAYER_TOKEN_ADDRESS: '',
    TRON_META_RELAYER_VAULT_ADDRESS: '',
  })
  assert.equal(result.checks.sponsorWalletAddressConfigured, false)
  assert.equal(result.checks.trustedForwarderAddressConfigured, false)
  assert.equal(result.submissionEnabled, false)
})
