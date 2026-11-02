import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { calculateTreasuryPayoutCapacity, remainingThirdPartyFundingPrincipal } from '../server/routes/treasury-withdrawals.mjs'

test('unfunded sponsor commitment never creates a spendable payout capacity', () => {
  const result = calculateTreasuryPayoutCapacity({
    verifiedSpendableBaseUnits: '0',
    outstandingReservationBaseUnits: '0',
    sponsorCommitmentRemainingBaseUnits: '100000000000',
    dailyLimitBaseUnits: '100000000000',
    dailyUsedBaseUnits: '0',
    maximumSinglePayoutBaseUnits: '100000000000',
    verifiedThirdPartyPrincipalRemainingBaseUnits: '0',
  })
  assert.equal(result.availableAfterReservationsBaseUnits, '0')
  assert.equal(result.eligibleCapacityBaseUnits, '0')
})

test('eligible payout capacity is the minimum of funded, unreserved, committed, daily and per-payout limits', () => {
  const result = calculateTreasuryPayoutCapacity({
    verifiedSpendableBaseUnits: '90000000000',
    outstandingReservationBaseUnits: '10000000000',
    sponsorCommitmentRemainingBaseUnits: '70000000000',
    dailyLimitBaseUnits: '50000000000',
    dailyUsedBaseUnits: '15000000000',
    maximumSinglePayoutBaseUnits: '25000000000',
    verifiedThirdPartyPrincipalRemainingBaseUnits: '40000000000',
  })
  assert.deepEqual(result, {
    verifiedSpendableBaseUnits: '90000000000',
    outstandingReservationBaseUnits: '10000000000',
    availableAfterReservationsBaseUnits: '80000000000',
    sponsorCommitmentRemainingBaseUnits: '70000000000',
    dailyLimitBaseUnits: '50000000000',
    dailyUsedBaseUnits: '15000000000',
    dailyRemainingBaseUnits: '35000000000',
    maximumSinglePayoutBaseUnits: '25000000000',
    verifiedThirdPartyPrincipalRemainingBaseUnits: '40000000000',
    eligibleCapacityBaseUnits: '25000000000',
  })
})

test('pending reservations consume available balance and cannot make capacity negative', () => {
  const result = calculateTreasuryPayoutCapacity({
    verifiedSpendableBaseUnits: '5000000',
    outstandingReservationBaseUnits: '8000000',
    sponsorCommitmentRemainingBaseUnits: '9000000',
    dailyLimitBaseUnits: '10000000',
    dailyUsedBaseUnits: '1000000',
    maximumSinglePayoutBaseUnits: '10000000',
    verifiedThirdPartyPrincipalRemainingBaseUnits: '9000000',
  })
  assert.equal(result.availableAfterReservationsBaseUnits, '0')
  assert.equal(result.eligibleCapacityBaseUnits, '0')
})

test('invalid or missing funding, reservation, agreement or limit evidence fails closed', () => {
  assert.equal(calculateTreasuryPayoutCapacity({
    verifiedSpendableBaseUnits: '1e6',
    outstandingReservationBaseUnits: '0',
    sponsorCommitmentRemainingBaseUnits: '1',
    dailyLimitBaseUnits: '1',
    dailyUsedBaseUnits: '0',
    maximumSinglePayoutBaseUnits: '1',
    verifiedThirdPartyPrincipalRemainingBaseUnits: '1',
  }), null)
  assert.equal(calculateTreasuryPayoutCapacity({
    verifiedSpendableBaseUnits: '100',
    outstandingReservationBaseUnits: null,
    sponsorCommitmentRemainingBaseUnits: '100',
    dailyLimitBaseUnits: '100',
    dailyUsedBaseUnits: '0',
    maximumSinglePayoutBaseUnits: '100',
    verifiedThirdPartyPrincipalRemainingBaseUnits: '100',
  }), null)
})

test('readiness endpoint subtracts pending reservations and reports zero withdrawable while the source lock is closed', async () => {
  const source = await readFile(new URL('../server/routes/treasury-withdrawals.mjs', import.meta.url), 'utf8')
  assert.match(source, /pendingUsdtReservations/)
  assert.ok(source.includes("status IN ('broadcasting','provider-pending','broadcast-accepted','broadcast-unknown')"))
  assert.match(source, /availableUsdtAfterReservationsBaseUnits/)
  assert.match(source, /estimatedEligiblePayoutCapacityBaseUnits/)
  assert.match(source, /sponsorPrincipalBudgetCapConsistent\s*&&\s*config\.sponsorAgreementScopeApproved === true/)
  assert.equal(source.split("WHERE created_at >= date_trunc('day', now())").length - 1, 2, 'readiness and submission use the same sponsor-wide daily usage query')
  assert.match(source, /payoutExecution\.executionEnabled && sponsorPayoutCapacity/)
  assert.match(source, /const REAL_VALUE_PAYOUT_EXECUTION_DISABLED = true/)
  assert.match(source, /getThirdPartyFundingUsdtPoolSnapshot\\(treasuryAddress\\)/)
  assert.match(source, /thirdParty-verified-usdt-deposit-and-reviewed-disbursement-mandate-required/)
  assert.match(source, /verifiedThirdPartyPrincipalRemainingBaseUnits: thirdPartyFunding\.availablePrincipalBaseUnits/)
  const post = source.slice(source.indexOf("router.post('/withdrawals'"))
  assert.match(post, /getThirdPartyFundingUsdtPoolSnapshot\\(treasuryAddress\\)/)
  assert.match(post, /remainingVerifiedThirdPartyPrincipalBaseUnits/)
  assert.match(post, /third-party-usdt-principal-insufficient-after-withdrawals/)
})

test('third-party principal pool subtracts all application and external outflows and cannot become negative', () => {
  assert.equal(remainingThirdPartyFundingPrincipal('100000000000', '25000000000'), '75000000000')
  assert.equal(remainingThirdPartyFundingPrincipal('100000000000', '100000000000'), '0')
  assert.equal(remainingThirdPartyFundingPrincipal('100000000000', '100000000001'), '0')
  assert.equal(remainingThirdPartyFundingPrincipal('1e6', '0'), null)
  assert.equal(remainingThirdPartyFundingPrincipal('100', '-1'), null)
})

test('verified incoming sponsor principal is an independent payout capacity ceiling', () => {
  const result = calculateTreasuryPayoutCapacity({
    verifiedSpendableBaseUnits: '90000000',
    outstandingReservationBaseUnits: '0',
    sponsorCommitmentRemainingBaseUnits: '80000000',
    dailyLimitBaseUnits: '70000000',
    dailyUsedBaseUnits: '0',
    maximumSinglePayoutBaseUnits: '60000000',
    verifiedThirdPartyPrincipalRemainingBaseUnits: '12000000',
  })
  assert.equal(result.eligibleCapacityBaseUnits, '12000000')
  assert.equal(result.verifiedThirdPartyPrincipalRemainingBaseUnits, '12000000')
  assert.equal(calculateTreasuryPayoutCapacity({
    verifiedSpendableBaseUnits: '100',
    outstandingReservationBaseUnits: '0',
    sponsorCommitmentRemainingBaseUnits: '100',
    dailyLimitBaseUnits: '100',
    dailyUsedBaseUnits: '0',
    maximumSinglePayoutBaseUnits: '100',
  }), null, 'missing third-party deposit evidence fails closed')
})
