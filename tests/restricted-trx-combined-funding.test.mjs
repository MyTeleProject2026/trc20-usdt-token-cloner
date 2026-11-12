import test from 'node:test'
import assert from 'node:assert/strict'
import { assertRestrictedTrxCreditAuthorization, getRestrictedTrxProviderReadiness } from '../server/restricted-trx-provider.mjs'

const escrowAddress = 'TLBWTZHjjRMwbFgKgqmLwjp4ZKjxt5a2GT'
const chainEvidence = { verified: true, solidified: true, network: 'TRON_MAINNET', receiverAddress: escrowAddress, energyLimit: '100000', bandwidthLimit: '5000', resourceTransactionIds: ['a'.repeat(64), 'b'.repeat(64)] }
const facility = () => ({
  providerId: 'ripple', authenticated: true, status: 'approved', facilityType: 'credit',
  asset: 'TRX', network: 'TRON_MAINNET', agreementReference: 'executed-agreement-reference',
  providerAuthorizationId: 'provider-auth-123', creditLimitSun: '100000000',
  availableCreditSun: '90000000', feeBudgetSun: '5000000',
  permittedTransactionTypes: ['TriggerSmartContract'],
  feeFundingMode: 'provider-paid-plus-delegated-resources',
  expiresAt: '2027-01-01T00:00:00.000Z', allowedDestinations: ['escrow'],
  delegatedResources: { verifiedOnChain: true, status: 'active', network: 'TRON_MAINNET',
    receiverAddress: escrowAddress, energyLimit: '100000', bandwidthLimit: '5000',
    resourceTransactionIds: ['a'.repeat(64), 'b'.repeat(64)], expiresAt: '2027-01-01T00:00:00.000Z' },
})
test('combined authorization requires provider fees and verified delegated resources', () => {
  const result = assertRestrictedTrxCreditAuthorization(facility(), { destination: 'escrow', amountSun: '25000000', feeBudgetSun: '1000000', escrowAddress, delegatedResourceVerification: chainEvidence, now: Date.parse('2026-11-13T00:00:00.000Z') })
  assert.equal(result.feeFundingMode, 'provider-paid-plus-delegated-resources')
  assert.equal(result.delegatedResourceEvidence.receiverAddress, escrowAddress)
  assert.equal(result.delegatedResourceEvidence.energyLimit, '100000')
  assert.equal(result.delegatedResourceEvidence.bandwidthLimit, '5000')
})
test('combined authorization rejects unverified or misdirected resource delegation', () => {
  const unverified = facility(); const unverifiedChain = { ...chainEvidence, solidified: false }
  assert.throws(() => assertRestrictedTrxCreditAuthorization(unverified, { destination: 'escrow', amountSun: '25000000', feeBudgetSun: '1000000', escrowAddress, delegatedResourceVerification: unverifiedChain, now: Date.parse('2026-11-13T00:00:00.000Z') }), { code: 'provider-delegated-resources-not-verified-for-escrow' })
  const wrongReceiver = facility(); wrongReceiver.delegatedResources.receiverAddress = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'
  assert.throws(() => assertRestrictedTrxCreditAuthorization(wrongReceiver, { destination: 'escrow', amountSun: '25000000', feeBudgetSun: '1000000', escrowAddress, delegatedResourceVerification: chainEvidence, now: Date.parse('2026-11-13T00:00:00.000Z') }), { code: 'provider-delegated-resources-not-verified-for-escrow' })
})
test('readiness keeps live execution disabled for combined funding model', () => {
  const readiness = getRestrictedTrxProviderReadiness({})
  assert.equal(readiness.fundingArrangement, 'provider-credit-plus-delegated-resources')
  assert.equal(readiness.feeCoverageArrangement, 'provider-paid-plus-delegated-resources')
  assert.equal(readiness.walletApiTransportImplemented, true)
  assert.equal(readiness.canBroadcastEscrowFunding, false)
  assert.equal(readiness.liveExecutionHardDisabled, true)
})
