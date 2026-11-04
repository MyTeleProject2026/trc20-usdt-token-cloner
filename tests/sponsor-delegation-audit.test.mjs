import test from 'node:test'
import assert from 'node:assert/strict'
import { verifySponsorDelegationTransactionAudit } from '../server/sponsor-delegation-audit.mjs'

const feeSponsor = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
const principalSponsor = 'TTGhREx2pDSxFX555NWz1YwGpiBVPvQA7e'
const otherSponsor = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const energyTx = 'a'.repeat(64)
const bandwidthTx = 'b'.repeat(64)

function baseInput(overrides = {}) {
  return {
    network: 'nile',
    feeSponsorAddress: feeSponsor,
    principalSponsorAddress: principalSponsor,
    liveSnapshot: {
      success: true,
      network: 'nile',
      fromAddress: feeSponsor,
      toAddress: principalSponsor,
      activeEnergyStakeSun: '9000000',
      activeBandwidthStakeSun: '3000000',
    },
    auditResult: {
      success: true,
      delegations: [
        {
          network: 'nile', transactionId: energyTx, sponsorAddress: feeSponsor,
          receiverAddress: principalSponsor, resourceType: 'ENERGY',
          stakeEquivalentSun: '9000000', blockNumber: 12345, status: 'verified-on-chain',
        },
        {
          network: 'nile', transactionId: bandwidthTx, sponsorAddress: feeSponsor,
          receiverAddress: principalSponsor, resourceType: 'BANDWIDTH',
          stakeEquivalentSun: '3000000', blockNumber: 12346, status: 'verified-on-chain',
        },
      ],
    },
    ...overrides,
  }
}

test('requires independently verified Energy and Bandwidth transactions for the exact sponsor pair', () => {
  const result = verifySponsorDelegationTransactionAudit(baseInput())
  assert.deepEqual(result, {
    verified: true,
    status: 'verified-energy-and-bandwidth-delegation-transactions',
    resourceTypes: ['ENERGY', 'BANDWIDTH'],
    transactionCount: 2,
  })
})

test('a live delegation snapshot without persisted transaction audit is not transaction-audited', () => {
  const result = verifySponsorDelegationTransactionAudit(baseInput({
    auditResult: { success: true, delegations: [] },
  }))
  assert.equal(result.verified, false)
  assert.equal(result.status, 'delegation-transaction-audit-missing-resource-types')
  assert.deepEqual(result.resourceTypes, [])
})

test('a record for another sponsor pair does not satisfy the configured pair audit', () => {
  const result = verifySponsorDelegationTransactionAudit(baseInput({
    auditResult: {
      success: true,
      delegations: [
        {
          network: 'nile', transactionId: energyTx, sponsorAddress: otherSponsor,
          receiverAddress: principalSponsor, resourceType: 'ENERGY',
          stakeEquivalentSun: '9000000', blockNumber: 12345, status: 'verified-on-chain',
        },
        {
          network: 'nile', transactionId: bandwidthTx, sponsorAddress: feeSponsor,
          receiverAddress: principalSponsor, resourceType: 'BANDWIDTH',
          stakeEquivalentSun: '3000000', blockNumber: 12346, status: 'verified-on-chain',
        },
      ],
    },
  }))
  assert.equal(result.verified, false)
  assert.deepEqual(result.resourceTypes, ['BANDWIDTH'])
})

test('an unverified or malformed transaction record fails closed', () => {
  const input = baseInput()
  input.auditResult.delegations[0].status = 'pending'
  const result = verifySponsorDelegationTransactionAudit(input)
  assert.equal(result.verified, false)
  assert.equal(result.status, 'delegation-transaction-audit-record-invalid')
})

test('truncated delegation history is inconclusive rather than accepted', () => {
  const rows = [...baseInput().auditResult.delegations]
  while (rows.length < 100) rows.push({ network: 'nile', sponsorAddress: otherSponsor })
  const result = verifySponsorDelegationTransactionAudit(baseInput({
    auditResult: { success: true, delegations: rows },
  }))
  assert.equal(result.verified, false)
  assert.equal(result.status, 'delegation-transaction-audit-history-truncated')
})

test('a persisted delegation amount above the current live allocation fails closed', () => {
  const input = baseInput()
  input.liveSnapshot.activeEnergyStakeSun = '8000000'
  input.auditResult.delegations[0].stakeEquivalentSun = '9000000'
  const result = verifySponsorDelegationTransactionAudit(input)
  assert.equal(result.verified, false)
  assert.equal(result.status, 'audited-delegation-stake-exceeds-current-allocation')
})

test('duplicate transaction identifiers cannot satisfy two resource proofs', () => {
  const input = baseInput()
  input.auditResult.delegations[1].transactionId = energyTx
  const result = verifySponsorDelegationTransactionAudit(input)
  assert.equal(result.verified, false)
  assert.equal(result.status, 'delegation-transaction-audit-duplicate')
})

test('missing live state cannot be replaced by historical transaction audit rows', () => {
  const result = verifySponsorDelegationTransactionAudit(baseInput({
    liveSnapshot: { success: false, activeEnergyStakeSun: null, activeBandwidthStakeSun: null },
  }))
  assert.equal(result.verified, false)
  assert.equal(result.status, 'live-delegation-state-not-verified')
})


test('a live snapshot for a different network or sponsor pair cannot satisfy delegation audit', () => {
  for (const liveSnapshot of [
    { ...baseInput().liveSnapshot, network: 'shasta' },
    { ...baseInput().liveSnapshot, fromAddress: otherSponsor },
    { ...baseInput().liveSnapshot, toAddress: otherSponsor },
  ]) {
    const result = verifySponsorDelegationTransactionAudit(baseInput({ liveSnapshot }))
    assert.equal(result.verified, false)
    assert.equal(result.status, 'live-delegation-state-not-verified')
  }
})


test('address-shaped values with an invalid TRON Base58Check checksum are rejected', () => {
  const result = verifySponsorDelegationTransactionAudit(baseInput({
    feeSponsorAddress: 'T' + 'A'.repeat(33),
  }))
  assert.equal(result.verified, false)
  assert.equal(result.status, 'invalid-delegation-audit-identity')
})
