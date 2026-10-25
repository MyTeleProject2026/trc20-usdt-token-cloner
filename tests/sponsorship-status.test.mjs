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

test('sponsor funds never masquerade as receiver wallet balance or spendable assets', () => {
  const status = getSponsorshipStatus()
  assert.deepEqual(status.receiverBalance, {
    source: 'verified-on-chain-only',
    displayOnlySponsorCredit: false,
    spendableSource: 'on-chain-wallet-balance',
    sponsorAssetGrantEnabled: false,
    sponsoredFeeCoverage: 'none',
    exchangeCredit: 'exchange-confirmation-required',
  })
  assert.ok(status.requiredBeforeEnablement.includes('explicit-sponsor-consent-and-funded-budget'))
  assert.ok(status.requiredBeforeEnablement.includes('idempotent-sponsor-ledger-and-reconciliation'))
  assert.match(status.message, /must not display sponsor budget or pending credits as receiver wallet balance/)
  assert.match(status.message, /Spendable balance must come from verified on-chain assets/)
})


test('provider research is informative only and never enables the requested no-user-cost mode', () => {
  const status = getSponsorshipStatus()
  const research = status.providerResearch
  assert.equal(research.publicSponsorVerifiedForPrincipalAndNetworkFees, false)
  assert.equal(research.status, 'research-only-no-verified-public-full-sponsor')
  assert.equal(research.selectedArchitecture, 'dual-sponsored-roles')
  assert.equal(status.canSubmitSponsoredTransfer, false)
  assert.equal(status.enabled, false)
  assert.equal(status.mainnetEnabled, false)
  const gasFree = research.candidates.find((candidate) => candidate.id === 'gasfree')
  assert.equal(gasFree.providesAssetPrincipal, false)
  assert.equal(gasFree.feeAsset, 'transferred-token')
  assert.equal(gasFree.productionEnabled, false)
  const tronTransfer = research.candidates.find((candidate) => candidate.id === 'trontransfer')
  assert.equal(tronTransfer.senderSignedFeeTransactionRequiredByPublishedFlow, true)
  assert.equal(tronTransfer.productionEnabled, false)
  const delegation = research.candidates.find((candidate) => candidate.id === 'tron-stake-2.0-resource-delegation')
  assert.equal(delegation.providesAssetPrincipal, false)
  assert.equal(delegation.productionEnabled, false)
})
