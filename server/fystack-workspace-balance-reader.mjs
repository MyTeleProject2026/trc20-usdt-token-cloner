import { createHmac } from 'node:crypto'

const API_BASE = 'https://api.fystack.io/api/v1'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DECIMAL = /^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/

/**
 * Build FYStack's documented ACCESS-SIGN header.
 * This helper is read-only in this module; do not reuse it to add write endpoints.
 */
export function createFystackReadSignature({ apiSecret, method, path, timestamp, body = '' }) {
  if (typeof apiSecret !== 'string' || !apiSecret) throw new Error('FYStack API secret is not configured')
  if (typeof method !== 'string' || !/^[A-Z]+$/.test(method)) throw new Error('Invalid FYStack HTTP method')
  if (typeof path !== 'string' || !path.startsWith('/api/v1/')) throw new Error('Invalid FYStack API path')
  if (typeof timestamp !== 'string' || !/^\d{10}$/.test(timestamp)) throw new Error('Invalid FYStack request timestamp')
  if (typeof body !== 'string') throw new Error('FYStack request body must be a string')
  const canonical = `method=${method}&path=${path}&timestamp=${timestamp}&body=${body}`
  const hexDigest = createHmac('sha256', apiSecret).update(canonical).digest('hex')
  return Buffer.from(hexDigest, 'utf8').toString('base64')
}

function normalizeNetworkBalance(row) {
  if (!row || typeof row !== 'object') return null
  const balance = typeof row.balance === 'string' ? row.balance : ''
  if (!DECIMAL.test(balance)) return null
  if (typeof row.network_name !== 'string' || !row.network_name.trim()) return null
  return Object.freeze({
    assetId: typeof row.asset_id === 'string' ? row.asset_id : null,
    networkId: typeof row.network_id === 'string' ? row.network_id : null,
    networkName: row.network_name,
    balance,
    walletCount: Number.isSafeInteger(row.wallet_count) && row.wallet_count >= 0 ? row.wallet_count : null,
  })
}

/**
 * Read-only workspace balance observer using FYStack's documented
 * GET /workspaces/{workspace_id}/balances?symbol=USDT endpoint.
 *
 * This endpoint aggregates across all wallets and networks. It is deliberately
 * NOT returned as a wallet-specific available balance and never changes the
 * Tron Transfer ledger or payout readiness.
 */
export function normalizeFystackWorkspaceUsdtBalances(payload) {
  const blockers = []
  const add = (ok, reason) => { if (!ok) blockers.push(reason) }
  add(payload?.success === true, 'provider-response-not-successful')
  add(payload?.code === 0, 'provider-response-code-not-zero')
  add(Array.isArray(payload?.data), 'provider-balance-data-not-array')

  const item = Array.isArray(payload?.data)
    ? payload.data.find((entry) => String(entry?.symbol || '').toUpperCase() === 'USDT')
    : null
  add(Boolean(item), 'workspace-usdt-symbol-not-found')

  const networks = item && Array.isArray(item.networks)
    ? item.networks.map(normalizeNetworkBalance).filter(Boolean)
    : []
  if (!networks.length) blockers.push('workspace-usdt-network-balances-missing')

  const tronMainnet = networks.filter((entry) => /^tron mainnet$/i.test(entry.networkName))
  if (!tronMainnet.length) blockers.push('workspace-tron-mainnet-usdt-not-found')

  return Object.freeze({
    schema: 'tron-transfer.fystack-workspace-usdt-observation.v1',
    status: blockers.length ? 'provider-balance-observation-blocked' : 'workspace-aggregate-observed',
    blockers: Object.freeze(blockers),
    scope: 'workspace-aggregate-across-wallets',
    symbol: 'USDT',
    workspaceTotalBalance: item && DECIMAL.test(String(item.total_balance)) ? String(item.total_balance) : null,
    tronMainnetNetworkBalances: Object.freeze(tronMainnet),
    walletSpecificBalanceVerified: false,
    tokenContractVerified: false,
    availableBalanceVerified: false,
    spendableBalanceImpact: 'none',
    ledgerMutationPerformed: false,
    creditApprovalGranted: false,
    payoutAuthorizationGranted: false,
    executionEnabled: false,
  })
}

export function createFystackWorkspaceBalanceReader({
  apiKey,
  apiSecret,
  workspaceId,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  return Object.freeze({
    async getWorkspaceUsdtBalances() {
      if (!apiKey || !apiSecret || !UUID.test(String(workspaceId || '')) || typeof fetchImpl !== 'function') {
        return normalizeFystackWorkspaceUsdtBalances(null)
      }
      const path = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/balances?symbol=USDT`
      const timestamp = Math.floor(now() / 1000).toString()
      let signature
      try {
        signature = createFystackReadSignature({ apiSecret, method: 'GET', path, timestamp })
        const response = await fetchImpl(API_BASE + path.slice('/api/v1'.length), {
          method: 'GET',
          headers: {
            'ACCESS-API-KEY': apiKey,
            'ACCESS-TIMESTAMP': timestamp,
            'ACCESS-SIGN': signature,
            Accept: 'application/json',
          },
        })
        if (!response?.ok) return normalizeFystackWorkspaceUsdtBalances(null)
        return normalizeFystackWorkspaceUsdtBalances(await response.json())
      } catch {
        return normalizeFystackWorkspaceUsdtBalances(null)
      }
    },
  })
}
