import test from 'node:test'
import assert from 'node:assert/strict'
import { reconcileProviderAndTronUsdtBalances } from '../server/provider-chain-usdt-reconciliation.mjs'

const nowMs = Date.parse('2026-11-10T12:00:00.000Z')
const providerSnapshot = {
  authenticated: true, status: 'verified', network: 'TRON_MAINNET',
  tokenContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6,
  walletAddress: 'TU3kjFuhtEo42tsCBtfYUAZxoqQ4yuSLQ5',
  balanceBaseUnits: '1250000000', checkedAt: '2026-11-10T11:59:00.000Z',
}
const chainSnapshot = {
  status: 'verified', network: 'TRON_MAINNET',
  tokenContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6,
  walletAddress: providerSnapshot.walletAddress,
  balanceBaseUnits: '1250000000', checkedAt: '2026-11-10T11:59:30.000Z',
}

test('fresh independent matching balances reconcile without enabling spending', () => {
  const result = reconcileProviderAndTronUsdtBalances({ providerSnapshot, chainSnapshot, nowMs })
  assert.equal(result.matched, true)
  assert.equal(result.status, 'independent-balances-match')
  assert.equal(result.spendableBalanceImpact, 'none')
  assert.equal(result.ledgerMutationPerformed, false)
  assert.equal(result.payoutAuthorizationGranted, false)
  assert.equal(result.executionEnabled, false)
})

test('mismatched balances and wallet identities block reconciliation', () => {
  const result = reconcileProviderAndTronUsdtBalances({
    providerSnapshot, chainSnapshot: { ...chainSnapshot, balanceBaseUnits: '1250000001', walletAddress: 'THPvaUhoh2Qn2y9THCZML3H815hhFhn5YC' }, nowMs,
  })
  assert.equal(result.matched, false)
  assert.ok(result.blockers.includes('wallet-address-mismatch'))
  assert.ok(result.blockers.includes('provider-chain-balance-mismatch'))
  assert.equal(result.executionEnabled, false)
})

test('testnet, wrong token, unverified source and stale snapshots fail closed', () => {
  const result = reconcileProviderAndTronUsdtBalances({
    providerSnapshot: { ...providerSnapshot, network: 'NILE_TESTNET', authenticated: false, tokenContract: 'wrong', checkedAt: '2026-11-10T11:50:00.000Z' },
    chainSnapshot, nowMs,
  })
  assert.equal(result.matched, false)
  for (const blocker of ['provider-snapshot-not-authenticated','provider-network-mismatch','provider-token-contract-mismatch','provider-snapshot-stale-or-invalid']) {
    assert.ok(result.blockers.includes(blocker))
  }
  assert.equal(result.signingEnabled, false)
  assert.equal(result.broadcastEnabled, false)
})

test('missing and malformed balances never reconcile', () => {
  const result = reconcileProviderAndTronUsdtBalances({ providerSnapshot: {}, chainSnapshot: {}, nowMs })
  assert.equal(result.matched, false)
  assert.ok(result.blockers.includes('provider-balance-invalid'))
  assert.ok(result.blockers.includes('chain-balance-invalid'))
  assert.equal(result.spendableBalanceImpact, 'none')
})
