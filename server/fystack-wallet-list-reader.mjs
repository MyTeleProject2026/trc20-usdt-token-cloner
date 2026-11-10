import { createFystackReadSignature } from './fystack-workspace-balance-reader.mjs'

const API_BASE = 'https://api.fystack.io/api/v1'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function normalizeWallet(row) {
  if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !UUID.test(row.id)) return null
  return Object.freeze({
    walletId: row.id,
    name: typeof row.name === 'string' ? row.name : null,
    role: typeof row.role === 'string' ? row.role : null,
    walletType: typeof row.wallet_type === 'string' ? row.wallet_type : null,
    // value_usd is a display valuation for the wallet, not token-denominated spendable funds.
    displayedValueUsd: typeof row.value_usd === 'string' && /^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(row.value_usd)
      ? row.value_usd : null,
    topAssets: Array.isArray(row.top_assets) ? row.top_assets.filter((asset) => asset && typeof asset === 'object').map((asset) => ({
      symbol: typeof asset.symbol === 'string' ? asset.symbol : null,
      valueUsd: typeof asset.value_usd === 'string' ? asset.value_usd : null,
    })) : [],
  })
}

/**
 * Read-only wallet inventory from FYStack's documented
 * GET /workspaces/:workspace_id/wallets endpoint.
 * This endpoint identifies wallets and returns display value/top assets.
 * It does not return an authoritative available/held USDT balance.
 */
export function normalizeFystackWalletInventory(payload, { expectedWalletId } = {}) {
  const rows = Array.isArray(payload) ? payload : []
  const wallets = rows.map(normalizeWallet).filter(Boolean)
  const matched = expectedWalletId ? wallets.find((wallet) => wallet.walletId === expectedWalletId) || null : null
  return Object.freeze({
    schema: 'tron-transfer.fystack-wallet-inventory.v1',
    status: !Array.isArray(payload) ? 'wallet-inventory-unavailable' : expectedWalletId && !matched ? 'configured-wallet-not-found' : 'wallet-inventory-observed',
    wallets: Object.freeze(wallets),
    matchedWallet: matched,
    walletIdentityMatched: Boolean(matched),
    walletSpecificUsdtBalanceVerified: false,
    availableUsdtVerified: false,
    heldUsdtVerified: false,
    tokenContractVerified: false,
    displayedUsdValueIsSpendable: false,
    ledgerMutationPerformed: false,
    payoutAuthorizationGranted: false,
    executionEnabled: false,
  })
}

export function createFystackWalletListReader({ apiKey, apiSecret, workspaceId, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  return Object.freeze({
    async getWorkspaceWallets({ expectedWalletId, limit = 100, offset = 0 } = {}) {
      if (!apiKey || !apiSecret || !UUID.test(String(workspaceId || ''))
        || !Number.isInteger(limit) || limit < 1 || limit > 100
        || !Number.isInteger(offset) || offset < 0 || typeof fetchImpl !== 'function') {
        return normalizeFystackWalletInventory(null, { expectedWalletId })
      }
      const path = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/wallets?limit=${limit}&offset=${offset}`
      const timestamp = Math.floor(now() / 1000).toString()
      try {
        const signature = createFystackReadSignature({ apiSecret, method: 'GET', path, timestamp })
        const response = await fetchImpl(API_BASE + path.slice('/api/v1'.length), {
          method: 'GET',
          headers: {
            'ACCESS-API-KEY': apiKey,
            'ACCESS-TIMESTAMP': timestamp,
            'ACCESS-SIGN': signature,
            Accept: 'application/json',
          },
        })
        if (!response?.ok) return normalizeFystackWalletInventory(null, { expectedWalletId })
        return normalizeFystackWalletInventory(await response.json(), { expectedWalletId })
      } catch {
        return normalizeFystackWalletInventory(null, { expectedWalletId })
      }
    },
  })
}
