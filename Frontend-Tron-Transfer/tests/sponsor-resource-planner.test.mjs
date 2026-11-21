import test from 'node:test'
import assert from 'node:assert/strict'
import { planSponsorResourceProvisioning } from '../src/sponsor-resource-planner.mjs'

const network = {
  totalEnergyLimit: '1000000',
  totalEnergyWeight: '1000',
  totalNetLimit: '1000000',
  totalNetWeight: '1000',
}

function base(overrides = {}) {
  return {
    resource: 'ENERGY',
    target: '2000',
    ownerAvailable: '1000',
    maxDelegatableSun: '2000000',
    sponsorBalanceSun: '10000000',
    protectedReserveSun: '2000000',
    network,
    stakingEnabled: true,
    maxStakeSun: '5000000',
    ...overrides,
  }
}

test('plans delegation from already-staked Sponsor capacity without staking more TRX', () => {
  const plan = planSponsorResourceProvisioning(base())
  assert.equal(plan.ready, true)
  assert.equal(plan.action, 'delegate')
  assert.equal(plan.amountSun, '1150000')
  assert.equal(plan.reason, 'existing-stake-can-cover-target')
})

test('plans only the incremental stake when existing Sponsor delegation capacity is short', () => {
  const plan = planSponsorResourceProvisioning(base({ maxDelegatableSun: '500000' }))
  assert.equal(plan.ready, true)
  assert.equal(plan.action, 'stake')
  assert.equal(plan.amountSun, '1000000')
  assert.equal(plan.estimatedStakeSun, '1150000')
  assert.equal(plan.requiresFreshReadBeforeDelegation, true)
})

test('rounds incremental staking up to the Sponsor engine one-TRX minimum', () => {
  const plan = planSponsorResourceProvisioning(base({ maxDelegatableSun: '1100000' }))
  assert.equal(plan.ready, true)
  assert.equal(plan.action, 'stake')
  assert.equal(plan.amountSun, '1000000')
})

test('blocks staking when the Sponsor balance would consume the protected reserve', () => {
  const plan = planSponsorResourceProvisioning(base({
    maxDelegatableSun: '0',
    sponsorBalanceSun: '2500000',
    protectedReserveSun: '2000000',
  }))
  assert.equal(plan.ready, false)
  assert.equal(plan.reason, 'insufficient-sponsor-balance-after-protected-reserve')
})

test('blocks incremental stake above the server-configured stake cap', () => {
  const plan = planSponsorResourceProvisioning(base({
    maxDelegatableSun: '0',
    maxStakeSun: '1000000',
  }))
  assert.equal(plan.ready, false)
  assert.equal(plan.reason, 'incremental-stake-exceeds-configured-cap')
})

test('blocks when staking is disabled and existing delegation capacity is insufficient', () => {
  const plan = planSponsorResourceProvisioning(base({
    maxDelegatableSun: '0',
    stakingEnabled: false,
  }))
  assert.equal(plan.ready, false)
  assert.equal(plan.reason, 'staking-disabled-or-existing-capacity-insufficient')
})

test('returns target-met without creating a transaction plan', () => {
  const plan = planSponsorResourceProvisioning(base({ ownerAvailable: '2500' }))
  assert.equal(plan.ready, true)
  assert.equal(plan.action, null)
  assert.equal(plan.reason, 'target-met')
})

test('fails closed when network weights are unavailable', () => {
  const plan = planSponsorResourceProvisioning(base({
    network: { totalEnergyLimit: '0', totalEnergyWeight: '0' },
  }))
  assert.equal(plan.ready, false)
  assert.equal(plan.reason, 'network-resource-weight-unavailable')
})

test('rejects malformed numeric inputs instead of coercing them', () => {
  const plan = planSponsorResourceProvisioning(base({ sponsorBalanceSun: '1e9' }))
  assert.equal(plan.ready, false)
  assert.equal(plan.reason, 'invalid-live-input')
})
