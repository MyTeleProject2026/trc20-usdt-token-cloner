/**
 * Read-only comparison of independent FYStack/provider and TRON Mainnet
 * treasury balance snapshots. A match is evidence only, never payout authority.
 */
const UINT = /^(0|[1-9][0-9]*)$/
const TX = 'TRON_MAINNET'
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

export function reconcileProviderAndTronUsdtBalances({
  providerSnapshot = {},
  chainSnapshot = {},
  nowMs = Date.now(),
  maxAgeMs = 120_000,
} = {}) {
  const blockers = []
  const add = (ok, reason) => { if (!ok) blockers.push(reason) }
  const validTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
  const providerTime = validTime(providerSnapshot.checkedAt) ? Date.parse(providerSnapshot.checkedAt) : NaN
  const chainTime = validTime(chainSnapshot.checkedAt) ? Date.parse(chainSnapshot.checkedAt) : NaN
  const fresh = (time) => Number.isFinite(time) && time <= nowMs && nowMs - time <= maxAgeMs
  add(providerSnapshot.authenticated === true, 'provider-snapshot-not-authenticated')
  add(providerSnapshot.network === TX, 'provider-network-mismatch')
  add(providerSnapshot.tokenContract === USDT, 'provider-token-contract-mismatch')
  add(providerSnapshot.decimals === 6, 'provider-decimals-mismatch')
  add(typeof providerSnapshot.walletAddress === 'string' && providerSnapshot.walletAddress.length > 0, 'provider-wallet-address-missing')
  add(providerSnapshot.walletAddress === chainSnapshot.walletAddress, 'wallet-address-mismatch')
  add(chainSnapshot.network === TX, 'chain-network-mismatch')
  add(chainSnapshot.tokenContract === USDT, 'chain-token-contract-mismatch')
  add(chainSnapshot.decimals === 6, 'chain-decimals-mismatch')
  add(providerSnapshot.status === 'verified', 'provider-balance-not-verified')
  add(chainSnapshot.status === 'verified', 'chain-balance-not-verified')
  add(UINT.test(String(providerSnapshot.balanceBaseUnits ?? '')), 'provider-balance-invalid')
  add(UINT.test(String(chainSnapshot.balanceBaseUnits ?? '')), 'chain-balance-invalid')
  add(fresh(providerTime), 'provider-snapshot-stale-or-invalid')
  add(fresh(chainTime), 'chain-snapshot-stale-or-invalid')
  add(providerSnapshot.balanceBaseUnits === chainSnapshot.balanceBaseUnits, 'provider-chain-balance-mismatch')
  const matched = blockers.length === 0
  return Object.freeze({
    schema: 'tron-transfer.provider-chain-usdt-reconciliation.v1',
    status: matched ? 'independent-balances-match' : 'reconciliation-blocked',
    matched,
    blockers: Object.freeze(blockers),
    providerBalanceBaseUnits: UINT.test(String(providerSnapshot.balanceBaseUnits ?? '')) ? String(providerSnapshot.balanceBaseUnits) : null,
    chainBalanceBaseUnits: UINT.test(String(chainSnapshot.balanceBaseUnits ?? '')) ? String(chainSnapshot.balanceBaseUnits) : null,
    spendableBalanceImpact: 'none',
    ledgerMutationPerformed: false,
    creditFacilityApprovalGranted: false,
    payoutAuthorizationGranted: false,
    signingEnabled: false,
    broadcastEnabled: false,
    executionEnabled: false,
  })
}
