import test from 'node:test'
import assert from 'node:assert/strict'
import { assessFystackWalletUsdtLiquidity } from '../server/fystack-wallet-liquidity-assessment.mjs'

const wallet = {
  schema: 'tron-transfer.fystack-readonly-usdt-snapshot.v1',
  status: 'normalized-read-only-provider-snapshot',
  snapshot: {
    workspaceId: 'workspace-1',
    walletId: 'wallet-1',
    walletAddress: 'TU3kjFuhtEo42tsCBtfYUAZxoqQ4yuSLQ5',
    network: 'TRON_MAINNET',
    tokenContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    decimals: 6,
    balanceKind: 'available',
    balanceBaseUnits: '1500000000',
  },
  verified: false,
  executionEnabled: false,
}
const expected = { expectedWalletId: 'wallet-1', expectedWalletAddress: wallet.snapshot.walletAddress }

test('observes sufficient wallet-specific balance without granting payout authority', () => {
  const result = assessFystackWalletUsdtLiquidity(wallet, { ...expected, amountUsdt: '1000' })
  assert.equal(result.status, 'wallet-liquidity-observed-only')
  assert.deepEqual(result.blockers, [])
  assert.equal(result.observedAvailableBaseUnits, '1500000000')
  assert.equal(result.providerBalanceVerified, false)
  assert.equal(result.payoutAuthorized, false)
  assert.equal(result.executionEnabled, false)
})

test('blocks insufficient, wrong-wallet, wrong-network and non-available snapshots', () => {
  const cases = [
    [wallet, { ...expected, amountUsdt: '2000' }, 'wallet-specific-observed-available-usdt-does-not-cover-request'],
    [{ ...wallet, snapshot: { ...wallet.snapshot, walletId: 'other' } }, { ...expected, amountUsdt: '1000' }, 'wallet-specific-snapshot-wallet-id-mismatch'],
    [{ ...wallet, snapshot: { ...wallet.snapshot, network: 'TRON_TESTNET' } }, { ...expected, amountUsdt: '1000' }, 'wallet-specific-snapshot-not-tron-mainnet'],
    [{ ...wallet, snapshot: { ...wallet.snapshot, balanceKind: 'total' } }, { ...expected, amountUsdt: '1000' }, 'wallet-specific-snapshot-not-available-balance'],
  ]
  for (const [snapshot, options, blocker] of cases) {
    const result = assessFystackWalletUsdtLiquidity(snapshot, options)
    assert.ok(result.blockers.includes(blocker))
    assert.equal(result.executionEnabled, false)
  }
})

test('enforces 1000 USDT minimum and strict six-decimal amount parsing', () => {
  for (const amountUsdt of ['999.999999', '1000.0000001', '1e3', 'NaN']) {
    const result = assessFystackWalletUsdtLiquidity(wallet, { ...expected, amountUsdt })
    assert.ok(result.blockers.length)
    assert.equal(result.payoutAuthorized, false)
  }
})

test('never treats a workspace aggregate as wallet-specific liquidity', () => {
  const aggregate = {
    status: 'workspace-aggregate-observed',
    workspaceTotalBalance: '50000',
    tronMainnetNetworkBalances: [{ balance: '50000' }],
  }
  const result = assessFystackWalletUsdtLiquidity(aggregate, { ...expected, amountUsdt: '1000' })
  assert.ok(result.blockers.includes('wallet-specific-provider-snapshot-unavailable'))
  assert.equal(result.observedAvailableBaseUnits, null)
  assert.equal(result.executionEnabled, false)
})
