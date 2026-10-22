import assert from 'node:assert/strict'
import test from 'node:test'
import { getSponsorshipStatus } from '../server/sponsorship-status.mjs'

test('sponsorship status remains fail-closed until provider and operational gates are reviewed', () => {
  const status = getSponsorshipStatus()
  assert.equal(status.enabled, false)
  assert.equal(status.mainnetEnabled, false)
  assert.equal(status.canSubmitSponsoredTransfer, false)
  assert.equal(status.network, null)
  assert.equal(status.provider, null)
  assert.equal(status.receiverRestrictionsAvailable, false)
  assert.equal(status.receiverBalance.sponsorAssetGrantEnabled, false)
  assert.equal(status.receiverBalance.sponsoredFeeCoverage, 'none')
  assert.equal(status.receiverBalance.spendableSource, 'on-chain-wallet-balance')
  assert.equal(status.receiverBalance.exchangeCredit, 'exchange-confirmation-required')
})

test('selected funding policy never charges the user or falls back to user funds', () => {
  const policy = getSponsorshipStatus().fundingPolicy
  assert.equal(policy.mode, 'external-sponsor-only')
  assert.equal(policy.userFundsRequiredForSponsoredFlow, false)
  assert.equal(policy.externalSponsorConfirmed, false)
  assert.equal(policy.sponsorFundingVerified, false)
  assert.equal(policy.paidProviderPurchasesAllowed, false)
  assert.equal(policy.feeSponsorshipAvailable, false)
  assert.equal(policy.sponsorFundedAssetTransfersAvailable, false)
  assert.equal(policy.unpaidFallbackToUserFunds, false)
})

test('sponsorship status exposes all operational gates rather than implying readiness', () => {
  const status = getSponsorshipStatus()
  for (const required of [
    'verified-provider-adapter-and-account',
    'explicit-sponsor-consent-and-funded-budget',
    'server-side-authorization-and-per-transfer-limits',
    'idempotent-sponsor-ledger-and-reconciliation',
    'separate-network-fee-and-asset-principal-budgets',
    'testnet-end-to-end-and-security-review',
    'mainnet-operator-approval-and-emergency-pause',
  ]) {
    assert.ok(status.requiredBeforeEnablement.includes(required), `missing gate: ${required}`)
  }
})
