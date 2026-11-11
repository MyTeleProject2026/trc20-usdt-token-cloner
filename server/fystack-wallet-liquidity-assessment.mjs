const UINT = /^(0|[1-9][0-9]*)$/
const DECIMAL = /^(0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/

function toBaseUnits(value) {
  if (typeof value !== 'string' || value.length > 40 || !DECIMAL.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6))
}

/**
 * Compare an already-normalized FYStack wallet snapshot with a requested amount.
 * This is an observation only: the upstream public API contract for wallet-level
 * available/held USDT is not yet documented, so this function cannot authorize payout.
 */
export function assessFystackWalletUsdtLiquidity(snapshotResult, { amountUsdt, expectedWalletId, expectedWalletAddress, nowMs = Date.now(), maxAgeMs = 120000 } = {}) {
  const blockers = []
  const add = (ok, reason) => { if (!ok) blockers.push(reason) }
  const snapshot = snapshotResult?.snapshot
  const requested = toBaseUnits(amountUsdt)
  add(snapshotResult?.schema === 'tron-transfer.fystack-readonly-usdt-snapshot.v1', 'wallet-specific-provider-snapshot-schema-mismatch')
  add(Boolean(snapshot), 'wallet-specific-provider-snapshot-unavailable')
  add(snapshotResult?.status === 'normalized-read-only-provider-snapshot', 'wallet-specific-provider-snapshot-not-normalized')
  add(snapshot?.network === 'TRON_MAINNET', 'wallet-specific-snapshot-not-tron-mainnet')
  add(snapshot?.tokenContract === 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'wallet-specific-snapshot-not-official-tron-usdt')
  add(snapshot?.decimals === 6, 'wallet-specific-snapshot-decimals-mismatch')
  add(snapshot?.balanceKind === 'available', 'wallet-specific-snapshot-not-available-balance')
  const checkedAt = typeof snapshot?.checkedAt === 'string' ? Date.parse(snapshot.checkedAt) : NaN
  add(Number.isFinite(checkedAt) && checkedAt <= nowMs && nowMs - checkedAt <= maxAgeMs, 'wallet-specific-snapshot-stale-or-invalid')
  add(typeof expectedWalletId === 'string' && snapshot?.walletId === expectedWalletId, 'wallet-specific-snapshot-wallet-id-mismatch')
  add(typeof expectedWalletAddress === 'string' && snapshot?.walletAddress === expectedWalletAddress, 'wallet-specific-snapshot-wallet-address-mismatch')
  add(requested !== null && requested >= 1_000_000_000n, 'minimum-withdrawal-1000-usdt-not-met')
  add(typeof snapshot?.balanceBaseUnits === 'string' && snapshot.balanceBaseUnits.length <= 80 && UINT.test(snapshot.balanceBaseUnits), 'wallet-specific-snapshot-balance-invalid')
  const available = typeof snapshot?.balanceBaseUnits === 'string' && snapshot.balanceBaseUnits.length <= 80 && UINT.test(snapshot.balanceBaseUnits)
    ? BigInt(snapshot.balanceBaseUnits) : null
  add(requested !== null && available !== null && available >= requested, 'wallet-specific-observed-available-usdt-does-not-cover-request')
  return Object.freeze({
    schema: 'tron-transfer.fystack-wallet-usdt-liquidity-assessment.v1',
    status: blockers.length ? 'wallet-liquidity-observation-blocked' : 'wallet-liquidity-observed-only',
    blockers: Object.freeze([...new Set(blockers)]),
    requestedAmountUsdt: requested === null ? null : amountUsdt,
    observedAvailableBaseUnits: available === null ? null : available.toString(),
    observationOnly: true,
    providerBalanceVerified: false,
    spendableBalanceImpact: 'none',
    ledgerMutationPerformed: false,
    creditApproved: false,
    payoutAuthorized: false,
    signingEnabled: false,
    broadcastingEnabled: false,
    executionEnabled: false,
  })
}
