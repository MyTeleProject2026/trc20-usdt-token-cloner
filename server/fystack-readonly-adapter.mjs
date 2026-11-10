/** Server-side read-only boundary for an injected, independently authenticated FYStack client. */
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const UINT = /^(0|[1-9][0-9]*)$/
const ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
function iso(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null }
export function normalizeFystackUsdtSnapshot(raw, expected = {}) {
 const blockers = []; const add = (ok, reason) => { if (!ok) blockers.push(reason) }
 const value = raw && typeof raw === 'object' ? raw : {};
 add(value.authenticated === true, 'provider-authentication-not-confirmed')
 add(value.network === 'TRON_MAINNET', 'provider-network-not-tron-mainnet')
 add(value.tokenContract === USDT, 'provider-token-not-official-tron-usdt')
 add(value.decimals === 6, 'provider-token-decimals-mismatch')
 add(ADDRESS.test(String(value.walletAddress || '')), 'provider-wallet-address-invalid')
 if (expected.walletAddress) add(value.walletAddress === expected.walletAddress, 'provider-wallet-address-unexpected')
 if (expected.workspaceId) add(value.workspaceId === expected.workspaceId, 'provider-workspace-mismatch')
 if (expected.walletId) add(value.walletId === expected.walletId, 'provider-wallet-id-mismatch')
 add(UINT.test(String(value.availableBalanceBaseUnits ?? '')), 'provider-available-usdt-balance-invalid')
 const checkedAt = iso(value.checkedAt); add(Boolean(checkedAt), 'provider-snapshot-time-invalid')
 return Object.freeze({ schema: 'tron-transfer.fystack-readonly-usdt-snapshot.v1', status: blockers.length ? 'blocked-unverified-provider-snapshot' : 'normalized-read-only-provider-snapshot', verified: false, blockers: Object.freeze(blockers), snapshot: blockers.length ? null : Object.freeze({ source: 'fystack-readonly-adapter', authenticated: true, workspaceId: value.workspaceId, walletId: value.walletId, walletAddress: value.walletAddress, network: 'TRON_MAINNET', tokenContract: USDT, decimals: 6, balanceBaseUnits: String(value.availableBalanceBaseUnits), checkedAt }), ledgerMutationPerformed: false, spendableBalanceImpact: 'none', creditApproved: false, payoutAuthorized: false, signingEnabled: false, broadcastEnabled: false, executionEnabled: false })
}
/** Requires an injected client with a documented read-only getWalletUsdtSnapshot method. No guessed URL or write operation. */
export function createFystackReadOnlyAdapter({ client, expected = {} } = {}) {
 return Object.freeze({
  async getUsdtSnapshot() {
   if (!client || typeof client.getWalletUsdtSnapshot !== 'function') return normalizeFystackUsdtSnapshot(null, expected)
   try { return normalizeFystackUsdtSnapshot(await client.getWalletUsdtSnapshot(), expected) }
   catch { return normalizeFystackUsdtSnapshot(null, expected) }
  },
 })
}
