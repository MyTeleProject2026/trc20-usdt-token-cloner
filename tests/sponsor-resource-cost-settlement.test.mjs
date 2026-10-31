import test from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateSponsorResourceCostSettlement,
  findApprovedSponsorResourceMandate,
  parseApprovedSponsorResourceMandates,
} from '../server/sponsor-resource-cost-settlement.mjs'
import { getSponsorFeeBudgetSettlementGate } from '../server/sponsor-fee-settlement-gate.mjs'

const feeSponsor = 'TTGhREx2pDSxFX555NWz1YwGpiBVPvQA7e'
const principal = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
const receiver = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH'
const key = 'resource-settlement-idempotency-key-0001'
const txid = 'a'.repeat(64)

function mandate(overrides = {}) {
  return {
    mandateReference: 'resource-mandate-001',
    sponsorReference: 'sponsor-pilot-001',
    network: 'nile',
    feeSponsorAddress: feeSponsor,
    assetPrincipalAddress: principal,
    energyBudgetUnits: '1000000',
    bandwidthBudgetUnits: '1000000',
    perTransferEnergyUnits: '500000',
    perTransferBandwidthUnits: '500000',
    ...overrides,
  }
}

function transfer(overrides = {}) {
  return {
    idempotencyKey: key,
    network: 'nile',
    transactionHash: txid,
    sponsorAddress: principal,
    receiverAddress: receiver,
    asset: 'USDT',
    tokenContract: 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH',
    amountBaseUnits: '1000000',
    ...overrides,
  }
}

function costs(overrides = {}) {
  return {
    network: 'nile',
    transactionHash: txid,
    feeSponsorAddress: feeSponsor,
    blockNumber: 123,
    executionResult: 'SUCCESS',
    reportedFeeSun: '0',
    energyFeeSun: '0',
    netFeeSun: '0',
    energyUsageTotal: '45000',
    energyUsage: '42000',
    originEnergyUsage: '3000',
    netUsage: '180',
    energyPenaltyTotal: '0',
    ...overrides,
  }
}

function reservation(overrides = {}) {
  return {
    idempotencyKey: key,
    network: 'nile',
    transactionHash: txid,
    feeSponsorAddress: feeSponsor,
    assetPrincipalAddress: principal,
    energyReservedUnits: '50000',
    bandwidthReservedUnits: '250',
    status: 'reserved',
    capacitySnapshot: {
      resourceCapacityPreflightPassed: true,
      feeSponsorResourceSourceVerified: true,
      feeSponsorAddress: feeSponsor,
      bandwidthCoverageSource: 'exact-active-fee-sponsor-delegation-only',
      energyCoverageSource: 'exact-active-fee-sponsor-delegation-only',
    },
    ...overrides,
  }
}

test('operator resource mandate parser accepts only exact Shasta/Nile role scopes and unit caps', () => {
  const env = { SPONSOR_APPROVED_RESOURCE_MANDATES: [
    Object.values(mandate()).join('|'),
    Object.values(mandate({ mandateReference: 'invalid-mainnet', network: 'mainnet' })).join('|'),
    Object.values(mandate({ mandateReference: 'invalid-role', feeSponsorAddress: principal })).join('|'),
    'not-a-nine-field-mandate',
  ].join(';') }
  const parsed = parseApprovedSponsorResourceMandates(env)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].mandateReference, 'resource-mandate-001')
  assert.equal(findApprovedSponsorResourceMandate({
    env, sponsorReference: 'sponsor-pilot-001', network: 'nile',
    feeSponsorAddress: feeSponsor, assetPrincipalAddress: principal,
  })?.mandateReference, 'resource-mandate-001')
  assert.equal(findApprovedSponsorResourceMandate({
    env, sponsorReference: 'sponsor-pilot-001', network: 'shasta',
    feeSponsorAddress: feeSponsor, assetPrincipalAddress: principal,
  }), null)
})

test('exact solidified receipt settles resource units and never claims a sponsor TRX debit', () => {
  const result = evaluateSponsorResourceCostSettlement({
    transfer: transfer(), costs: costs(), reservation: reservation(),
  })
  assert.equal(result.settled, true)
  assert.equal(result.energyConsumedUnits, '42000')
  assert.equal(result.bandwidthConsumedUnits, '180')
  assert.equal(result.energyReleasedUnits, '8000')
  assert.equal(result.bandwidthReleasedUnits, '70')
  assert.equal(result.reportedFeeSun, '0')
  assert.equal(result.directFeeSponsorTrxDebitVerified, false)
})

test('any actual TRX fee burn goes to manual review and cannot consume the delegated-resource budget', () => {
  for (const receipt of [
    costs({ reportedFeeSun: '1' }),
    costs({ energyFeeSun: '1' }),
    costs({ netFeeSun: '1' }),
  ]) {
    const result = evaluateSponsorResourceCostSettlement({
      transfer: transfer(), costs: receipt, reservation: reservation(),
    })
    assert.equal(result.settled, false)
    assert.equal(result.status, 'manual-review')
    assert.equal(result.reason, 'unexpected-trx-fee-burn-observed')
  }
})

test('incomplete fee/resource evidence remains held for manual review', () => {
  const missingFee = evaluateSponsorResourceCostSettlement({
    transfer: transfer(), costs: costs({ netFeeSun: null }), reservation: reservation(),
  })
  const missingBandwidth = evaluateSponsorResourceCostSettlement({
    transfer: transfer(), costs: costs({ netUsage: null }), reservation: reservation(),
  })
  assert.equal(missingFee.reason, 'solidified-fee-fields-incomplete')
  assert.equal(missingBandwidth.reason, 'solidified-resource-usage-incomplete')
})

test('usage above the exact reserved resource units is not settled', () => {
  const result = evaluateSponsorResourceCostSettlement({
    transfer: transfer(),
    costs: costs({ energyUsage: '50001' }),
    reservation: reservation(),
  })
  assert.equal(result.status, 'manual-review')
  assert.equal(result.reason, 'actual-resource-usage-exceeded-reservation')
})

test('resource settlement rejects a different fee sponsor, principal, transaction or delegation source', () => {
  const cases = [
    { reservation: reservation({ feeSponsorAddress: principal }) },
    { transfer: transfer({ sponsorAddress: receiver }) },
    { costs: costs({ transactionHash: 'b'.repeat(64) }) },
    { reservation: reservation({ capacitySnapshot: { resourceCapacityPreflightPassed: true } }) },
  ]
  for (const item of cases) {
    const result = evaluateSponsorResourceCostSettlement({
      transfer: item.transfer || transfer(),
      costs: item.costs || costs(),
      reservation: item.reservation || reservation(),
    })
    assert.equal(result.settled, false)
    assert.equal(result.status, 'manual-review')
  }
})

test('native TRX transfer may have zero caller Energy use but still requires measured Bandwidth and zero TRX fees', () => {
  const result = evaluateSponsorResourceCostSettlement({
    transfer: transfer({ asset: 'TRX', tokenContract: null }),
    costs: costs({ energyUsage: null, energyUsageTotal: null }),
    reservation: reservation({ energyReservedUnits: '0', energyReservedUnits: '0' }),
  })
  assert.equal(result.settled, true)
  assert.equal(result.energyConsumedUnits, '0')
  assert.equal(result.bandwidthConsumedUnits, '180')
})

test('testnet sponsor signing remains blocked until separate pilot approval and explicit opt-in', () => {
  assert.equal(getSponsorFeeBudgetSettlementGate({}).ready, false)
  const partial = getSponsorFeeBudgetSettlementGate({
    SPONSOR_TESTNET_PILOT_RELEASE_APPROVED: 'true',
  })
  assert.equal(partial.ready, false)
  assert.ok(partial.blockers.includes('testnet-signed-broadcast-flag-disabled'))
  const enabled = getSponsorFeeBudgetSettlementGate({
    SPONSOR_TESTNET_PILOT_RELEASE_APPROVED: 'true',
    SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED: 'true',
  })
  assert.equal(enabled.ready, true)
  assert.equal(enabled.mainnetSubmissionSupported, false)
})
