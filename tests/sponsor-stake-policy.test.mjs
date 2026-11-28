import test from 'node:test'
import assert from 'node:assert/strict'
import { planSponsorStake } from '../server/sponsor-stake-policy.mjs'

const sponsorAddress = 'TQ8r4gM6y2sW9nK3pL7vX5aB1cD8eF4gHj'
const ownerAddress = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'

test('Stake 2.0 policy converts decimal TRX to exact SUN without floating point', () => {
  const result = planSponsorStake({ amountTrx: '1.000001', resource: 'ENERGY', sponsorBalanceSun: '5000000', sponsorAddress, ownerAddress })
  assert.equal(result.ready, true)
  assert.equal(result.amountSun, '1000001')
  assert.equal(result.remainingLiquidBalanceSun, '3999999')
  assert.equal(result.transactionCreated, false)
})

test('Stake 2.0 policy rejects amounts below one TRX and unknown resources', () => {
  assert.equal(planSponsorStake({ amountTrx: '0.999999', resource: 'ENERGY', sponsorBalanceSun: '5000000', sponsorAddress, ownerAddress }).status, 'below-application-minimum-one-trx')
  assert.equal(planSponsorStake({ amountTrx: '1', resource: 'TRX', sponsorBalanceSun: '5000000', sponsorAddress, ownerAddress }).status, 'invalid-stake-resource')
})

test('Stake 2.0 policy preserves protected reserve and automatic ceiling', () => {
  assert.equal(planSponsorStake({ amountTrx: '4', resource: 'ENERGY', sponsorBalanceSun: '5000000', sponsorAddress, ownerAddress }).status, 'insufficient-spendable-balance-after-protected-reserve')
  assert.equal(planSponsorStake({ amountTrx: '11', resource: 'ENERGY', sponsorBalanceSun: '20000000', sponsorAddress, ownerAddress }).status, 'exceeds-automatic-stake-ceiling')
})

test('Stake 2.0 policy refuses Sponsor and Owner identity collision', () => {
  assert.equal(planSponsorStake({ amountTrx: '1', resource: 'BANDWIDTH', sponsorBalanceSun: '5000000', sponsorAddress: ownerAddress, ownerAddress }).status, 'invalid-or-non-independent-wallet-identities')
})
