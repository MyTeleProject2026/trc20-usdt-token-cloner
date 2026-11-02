import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { calculateTreasuryPayoutCapacity } from '../server/routes/treasury-withdrawals.mjs'

test('unfunded sponsor commitment never creates a spendable payout capacity', () => {
  const result = calculateTreasuryPayoutCapacity({
    verifiedSpendableBaseUnits: '0',
    outstandingReservationBaseUnits: '0',
    sponsorCommitmentRemainingBaseUnits: '100000000000',
    dailyLimitBaseUnits: '100000000000',
    dailyUsedBaseUnits: '0',
    maximumSinglePayoutBaseUnits: '100000000000',
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
  }), null)
  assert.equal(calculateTreasuryPayoutCapacity({
    verifiedSpendableBaseUnits: '100',
    outstandingReservationBaseUnits: null,
    sponsorCommitmentRemainingBaseUnits: '100',
    dailyLimitBaseUnits: '100',
    dailyUsedBaseUnits: '0',
    maximumSinglePayoutBaseUnits: '100',
  }), null)
})

test('readiness endpoint subtracts pending reservations and reports zero withdrawable while the source lock is closed', async () => {
  const source = await readFile(new URL('../server/routes/treasury-withdrawals.mjs', import.meta.url), 'utf8')
  assert.match(source, /pendingUsdtReservations/)
  assert.match(source, /status IN \\(?'broadcasting','provider-pending','broadcast-accepted','broadcast-unknown'/)
  assert.match(source, /availableUsdtAfterReservationsBaseUnits/)
  assert.match(source, /estimatedEligiblePayoutCapacityBaseUnits/)
  assert.match(source, /payoutExecution\.executionEnabled && sponsorPayoutCapacity/)
  assert.match(source, /const REAL_VALUE_PAYOUT_EXECUTION_DISABLED = true/)
})
