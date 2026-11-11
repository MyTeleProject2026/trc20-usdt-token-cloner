import test from 'node:test'
import assert from 'node:assert/strict'
import { assessTronWithdrawalPreflight } from '../server/tron-withdrawal-preflight.mjs'

const nowMs = Date.parse('2026-11-11T00:01:00.000Z')
const walletSnapshot = {
  schema: 'tron-transfer.fystack-readonly-usdt-snapshot.v1',
  status: 'normalized-read-only-provider-snapshot',
  snapshot: {
    walletId: 'wallet-1',
    walletAddress: 'TU3kjFuhtEo42tsCBtfYUAZxoqQ4yuSLQ5',
    network: 'TRON_MAINNET',
    tokenContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    decimals: 6,
    balanceKind: 'available',
    balanceBaseUnits: '1500000000',
    checkedAt: '2026-11-11T00:00:00.000Z',
  },
}
const tronResourceSnapshot = {
  network: 'TRON_MAINNET',
  address: 'TU3kjFuhtEo42tsCBtfYUAZxoqQ4yuSLQ5',
  checkedAt: '2026-11-11T00:00:30.000Z',
  energyAvailable: '100000',
  bandwidthAvailable: '5000',
  trxBalanceSun: '2000000',
}
const base = {
  amountUsdt: '1000',
  walletSnapshot,
  expectedWalletId: 'wallet-1',
  expectedWalletAddress: walletSnapshot.snapshot.walletAddress,
  tronResourceSnapshot,
  recipientAddressValid: true,
  recipientNetworkConfirmed: true,
  screeningCleared: true,
  approvalSatisfied: true,
  nowMs,
}

test('composes current wallet and TRON resource observations without authorizing payout', () => {
  const result = assessTronWithdrawalPreflight(base)
  assert.equal(result.status, 'withdrawal-preflight-blocked')
  assert.deepEqual(result.blockers, [
    'provider-payout-authorization-not-verified',
    'provider-wallet-identity-not-verified',
    'wallet-specific-available-usdt-not-verified',
    'available-usdt-does-not-cover-request',
    'tron-mainnet-usdt-contract-not-verified',
    'tron-mainnet-gas-not-verified',
    'recipient-kyt-screening-not-cleared',
    'withdrawal-approval-not-satisfied',
    'settlement-reconciliation-not-ready',
    'neither-provider-owned-liquidity-nor-evidenced-approved-credit-permitted-for-requested-tron-usdt-withdrawal-is-available',
  ])
  assert.equal(result.tronResources.observed, true)
  assert.equal(result.tronResources.feeSufficiencyVerified, false)
  assert.equal(result.reservationCreated, false)
  assert.equal(result.payoutAuthorized, false)
  assert.equal(result.signingEnabled, false)
  assert.equal(result.broadcastingEnabled, false)
  assert.equal(result.executionEnabled, false)
})

test('blocks stale, wrong-address and non-mainnet resource observations', () => {
  for (const snapshot of [
    { ...tronResourceSnapshot, checkedAt: '2026-11-10T23:00:00.000Z' },
    { ...tronResourceSnapshot, address: 'TJRabPrwbZy45sbavfc請' },
    { ...tronResourceSnapshot, network: 'TRON_TESTNET' },
  ]) {
    const result = assessTronWithdrawalPreflight({ ...base, tronResourceSnapshot: snapshot })
    assert.ok(result.blockers.includes('tron-mainnet-resource-snapshot-missing-stale-or-invalid'))
    assert.equal(result.executionEnabled, false)
  }
})

test('requires recipient confirmation and screening', () => {
  const result = assessTronWithdrawalPreflight({
    ...base, recipientNetworkConfirmed: false, screeningCleared: false,
  })
  assert.ok(result.blockers.includes('recipient-network-not-confirmed-as-tron-mainnet-trc20'))
  assert.ok(result.blockers.includes('recipient-screening-not-cleared'))
  assert.equal(result.executionEnabled, false)
})
