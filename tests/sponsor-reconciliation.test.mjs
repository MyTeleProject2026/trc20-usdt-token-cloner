import test from 'node:test'
import assert from 'node:assert/strict'
import { reconcileSponsorBudgets } from '../server/sponsor-reconciliation.mjs'

const sponsorAddress = 'T' + 'A'.repeat(33)
const tokenAddress = 'T' + 'B'.repeat(33)
const officialUsdt = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

function snapshot(network = 'shasta', overrides = {}) {
  return {
    status: 'solidified-sponsor-balances-read',
    onChainBalanceRead: true,
    network,
    source: 'Tatum TRON SolidityNode account and constant-contract queries',
    sponsorAddress,
    checkedAt: new Date().toISOString(),
    cache: { status: 'fresh', ageMs: 0 },
    native: { status: 'verified', asset: 'TRX', balanceSun: '150', balanceTRX: '0.00015' },
    tokens: [],
    ...overrides,
  }
}

function budget({
  sponsor_reference = 'sponsor-test',
  sponsor_address = sponsorAddress,
  network = 'shasta',
  purpose = 'asset-grant',
  asset = 'TRX',
  token_contract = null,
  budget_base_units = '100',
  reserved_base_units = '0',
  spent_base_units = '0',
  status = 'active',
  approvalScopeVerified = true,
} = {}) {
  return {
    sponsor_reference,
    sponsor_address,
    network,
    purpose,
    asset,
    token_contract,
    budget_base_units,
    reserved_base_units,
    spent_base_units,
    status,
    approvalScopeVerified,
  }
}

test('reconciliation aggregates active, paused, and outstanding reservations by exact asset contract', () => {
  const result = reconcileSponsorBudgets({
    network: 'shasta',
    fundingSnapshot: snapshot(),
    budgets: [
      budget({ budget_base_units: '100', reserved_base_units: '20', spent_base_units: '10', status: 'active' }),
      budget({ sponsor_reference: 'sponsor-second', purpose: 'network-fee', budget_base_units: '50', reserved_base_units: '10', spent_base_units: '5', status: 'paused' }),
      budget({ sponsor_reference: 'sponsor-third', budget_base_units: '30', reserved_base_units: '4', status: 'pending-review' }),
    ],
  })

  assert.equal(result.success, true)
  assert.equal(result.status, 'covered')
  assert.equal(result.groups.length, 1)
  assert.equal(result.groups[0].committedBaseUnits, '139')
  assert.equal(result.groups[0].onChainBalanceBaseUnits, '150')
  assert.equal(result.groups[0].deficitBaseUnits, '0')
  assert.equal(result.groups[0].activeBudgetCount, 1)
  assert.equal(result.groups[0].pausedBudgetCount, 1)
  assert.equal(result.groups[0].pendingReviewBudgetCount, 1)
  assert.equal(result.canSubmitSponsoredTransfer, false)
  assert.equal(result.submissionEnabled, false)
})

test('reconciliation flags an underfunded sponsor allocation and quantifies the shortfall', () => {
  const result = reconcileSponsorBudgets({
    network: 'shasta',
    fundingSnapshot: snapshot('shasta', {
      native: { status: 'verified', asset: 'TRX', balanceSun: '100', balanceTRX: '0.0001' },
    }),
    budgets: [
      budget({ budget_base_units: '150', spent_base_units: '25', reserved_base_units: '15', status: 'active' }),
    ],
  })

  assert.equal(result.success, true)
  assert.equal(result.status, 'underfunded')
  assert.equal(result.groups[0].committedBaseUnits, '125')
  assert.equal(result.groups[0].onChainBalanceBaseUnits, '100')
  assert.equal(result.groups[0].deficitBaseUnits, '25')
})

test('reconciliation requires the exact configured token contract balance and Mainnet USDT identity', () => {
  const tokenSnapshot = snapshot('mainnet', {
    native: { status: 'verified', asset: 'TRX', balanceSun: '10', balanceTRX: '0.00001' },
    tokens: [
      { asset: 'USDT', tokenContract: officialUsdt, status: 'verified', balanceBaseUnits: '1200000', decimals: 6 },
      { asset: 'USDT', tokenContract: tokenAddress, status: 'verified', balanceBaseUnits: '999999999', decimals: 6 },
    ],
  })
  const correct = reconcileSponsorBudgets({
    network: 'mainnet',
    fundingSnapshot: tokenSnapshot,
    budgets: [
      budget({
        network: 'mainnet',
        asset: 'USDT',
        token_contract: officialUsdt,
        budget_base_units: '1000000',
        status: 'active',
      }),
    ],
  })
  assert.equal(correct.groups[0].status, 'covered')
  assert.equal(correct.groups[0].onChainBalanceBaseUnits, '1200000')

  const incorrect = reconcileSponsorBudgets({
    network: 'mainnet',
    fundingSnapshot: tokenSnapshot,
    budgets: [
      budget({
        network: 'mainnet',
        asset: 'USDT',
        token_contract: tokenAddress,
        budget_base_units: '1000000',
        status: 'active',
      }),
    ],
  })
  assert.equal(incorrect.success, false)
  assert.equal(incorrect.status, 'balance-unavailable')
  assert.equal(incorrect.groups[0].onChainBalanceBaseUnits, null)
})

test('reconciliation rejects stale, wrong-network, and wallet-mismatched inputs without claiming coverage', () => {
  const stale = reconcileSponsorBudgets({
    network: 'shasta',
    fundingSnapshot: snapshot('shasta', { checkedAt: '2020-01-01T00:00:00.000Z' }),
    budgets: [budget()],
  })
  assert.equal(stale.success, false)
  assert.equal(stale.status, 'funding-snapshot-stale')

  const wrongNetwork = reconcileSponsorBudgets({
    network: 'mainnet',
    fundingSnapshot: snapshot('shasta'),
    budgets: [budget()],
  })
  assert.equal(wrongNetwork.success, false)
  assert.equal(wrongNetwork.status, 'fresh-solidified-funding-snapshot-required')

  const mismatch = reconcileSponsorBudgets({
    network: 'shasta',
    fundingSnapshot: snapshot(),
    budgets: [budget({ sponsor_address: 'T' + 'C'.repeat(33) })],
  })
  assert.equal(mismatch.success, false)
  assert.equal(mismatch.status, 'wallet-scope-mismatch')
  assert.equal(mismatch.walletMismatchCount, 1)
  assert.equal(mismatch.groups.length, 0)
})

test('reconciliation rejects invalid ledger numerics and never treats them as covered', () => {
  const result = reconcileSponsorBudgets({
    network: 'shasta',
    fundingSnapshot: snapshot(),
    budgets: [budget({ reserved_base_units: 'bad' })],
  })
  assert.equal(result.success, false)
  assert.equal(result.status, 'invalid-budget-ledger-record')
})


test('reconciliation does not report coverage for an unapproved active budget', () => {
  const result = reconcileSponsorBudgets({
    network: 'shasta',
    fundingSnapshot: snapshot(),
    budgets: [
      budget({ budget_base_units: '100', approvalScopeVerified: false }),
    ],
  })
  assert.equal(result.success, false)
  assert.equal(result.status, 'approval-required')
  assert.equal(result.groups[0].unapprovedActiveBudgetCount, 1)
  assert.equal(result.groups[0].onChainBalanceBaseUnits, '150')
  assert.equal(result.canSubmitSponsoredTransfer, false)
})


test('reconciliation reports current approval scope gaps on active allocations', () => {
  const result = reconcileSponsorBudgets({
    network: 'shasta',
    fundingSnapshot: snapshot(),
    budgets: [
      budget({ budget_base_units: '100', approvalScopeVerified: false }),
    ],
  })
  assert.equal(result.success, false)
  assert.equal(result.status, 'approval-required')
  assert.equal(result.groups[0].unapprovedActiveBudgetCount, 1)
})
