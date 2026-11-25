import { TronWeb, providers } from 'tronweb'

export const TRON_MAINNET_RPC = 'https://api.trongrid.io'
export const TATUM_MAINNET_RPC = 'https://tron-mainnet.gateway.tatum.io'

const READ_ONLY_PATHS = new Set([
  "/wallet/getaccount","/walletsolidity/getaccount","/wallet/getaccountresource","/wallet/getaccountnet",
  "/wallet/getaccountbalance","/wallet/getchainparameters","/wallet/getcontract","/wallet/getcontractinfo",
  "/wallet/triggerconstantcontract","/wallet/estimateenergy","/wallet/gettransactionbyid",
  "/wallet/gettransactioninfobyid","/walletsolidity/gettransactionbyid","/walletsolidity/gettransactioninfobyid",
  "/wallet/getdelegatedresourcev2","/walletsolidity/getdelegatedresourcev2","/wallet/getdelegatedresource",
  "/walletsolidity/getdelegatedresource","/wallet/getcandelegatedmaxsize","/walletsolidity/getcandelegatedmaxsize",
  "/wallet/getavailableunfreezecount","/walletsolidity/getavailableunfreezecount",
  "/wallet/getcanwithdrawunfreezeamount","/walletsolidity/getcanwithdrawunfreezeamount",
  "/wallet/getsignweight","/wallet/getnowblock","/walletsolidity/getnowblock",
  "/wallet/getblockbynum","/wallet/getblockbyid","/wallet/getnodeinfo"
])
const DEFAULT_TIMEOUT_MS = 8_000

function tatumBaseUrl(env) {
  const configured = typeof env.TATUM_TRON_RPC_URL === 'string' ? env.TATUM_TRON_RPC_URL.trim() : ''
  if (!configured) return TATUM_MAINNET_RPC
  try {
    const url = new URL(configured)
    if (url.protocol !== 'https:' || url.hostname !== 'tron-mainnet.gateway.tatum.io'
      || url.username || url.password || url.search || url.hash) return TATUM_MAINNET_RPC
    return url.origin
  } catch { return TATUM_MAINNET_RPC }
}

function providerConfig(env) {
  const tronGridKey = typeof env.TRONGRID_API_KEY === 'string' ? env.TRONGRID_API_KEY.trim() : ''
  const tronGrid = {
    id: 'trongrid',
    baseUrl: TRON_MAINNET_RPC,
    headers: tronGridKey ? { 'TRON-PRO-API-KEY': tronGridKey } : {},
  }
  const tatumKey = typeof env.TATUM_API_KEY === 'string' ? env.TATUM_API_KEY.trim() : ''
  const tatumEnabled = Boolean(tatumKey)
    && String(env.TATUM_TRON_NETWORK || 'mainnet').toLowerCase() === 'mainnet'
  const tatum = tatumEnabled ? {
    id: 'tatum',
    baseUrl: tatumBaseUrl(env),
    headers: { 'x-api-key': tatumKey },
  } : null
  return { tronGrid, tatum }
}

function normalizedPath(value) {
  const raw = String(value || '').trim()
  if (!raw) throw new TypeError('A TRON Mainnet RPC path is required.')
  let parsed
  try { parsed = new URL(raw, TRON_MAINNET_RPC + '/') }
  catch { throw new TypeError('Invalid TRON Mainnet RPC path.') }
  if (![TRON_MAINNET_RPC, TATUM_MAINNET_RPC].includes(parsed.origin)) {
    throw new Error('RPC provider path must remain on an approved TRON Mainnet endpoint.')
  }
  return parsed.pathname + parsed.search
}

function retryAfterMs(response) {
  const raw = response?.headers?.get?.('retry-after')
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(30_000, Math.max(5_000, seconds * 1000))
    : 5_000
}

function rpcError(response, data, path, providerId) {
  const detail = String(data?.Error || data?.error || (providerId + ' rejected ' + path)).slice(0, 200)
  const error = new Error(detail)
  error.status = response?.status || 502
  error.provider = providerId
  error.response = { status: response?.status || 502, headers: response?.headers, data }
  return error
}

export function createMainnetRpcProvider({
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be a positive integer.')
  const { tronGrid, tatum } = providerConfig(env)
  const cooldownUntil = new Map()

  class TatumFirstMainnetProvider extends providers.HttpProvider {
    constructor() {
      super(TRON_MAINNET_RPC, timeoutMs, '', '', {
        accept: 'application/json',
        'content-type': 'application/json',
        ...tronGrid.headers,
      })
    }

    async request(url, payload = {}, method = 'get') {
      const path = normalizedPath(url)
      const verb = String(method || 'get').toLowerCase()
      if (!['get', 'post'].includes(verb)) throw new Error('Unsupported TRON Mainnet RPC method.')
      // Only an explicit allowlist of read-only node methods may use Tatum.
      // Transaction construction and every write/broadcast remain TronGrid-only.
      const readOnly = READ_ONLY_PATHS.has(path.split('?')[0].toLowerCase())
      const candidates = readOnly && tatum ? [tatum, tronGrid] : [tronGrid]
      let lastError = null

      for (const node of candidates) {
        const until = cooldownUntil.get(node.id) || 0
        if (Date.now() < until) continue

        let endpoint = node.baseUrl + path
        const headers = {
          accept: 'application/json',
          'content-type': 'application/json',
          ...node.headers,
        }
        const options = {
          method: verb.toUpperCase(),
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        }
        if (verb === 'post') {
          options.body = JSON.stringify(payload && typeof payload === 'object' ? payload : {})
        } else if (payload && typeof payload === 'object') {
          const query = new URLSearchParams()
          for (const [key, value] of Object.entries(payload)) {
            if (value !== undefined && value !== null) {
              query.set(key, typeof value === 'string' ? value : JSON.stringify(value))
            }
          }
          const suffix = query.toString()
          if (suffix) endpoint += (endpoint.includes('?') ? '&' : '?') + suffix
        }

        try {
          const response = await fetchImpl(endpoint, options)
          let data
          try { data = await response.json() }
          catch { throw rpcError(response, { Error: 'invalid JSON response' }, path, node.id) }
          if (!response.ok || data?.Error || data?.error) {
            const error = rpcError(response, data, path, node.id)
            if (response.status === 429) cooldownUntil.set(node.id, Date.now() + retryAfterMs(response))
            lastError = error
            continue
          }
          cooldownUntil.delete(node.id)
          return data
        } catch (error) {
          if (error?.status === 429) cooldownUntil.set(node.id, Date.now() + retryAfterMs(error.response))
          lastError = error
        }
      }

      throw lastError || new Error('TRON Mainnet RPC providers are temporarily unavailable.')
    }
  }

  return new TatumFirstMainnetProvider()
}

export function createMainnetTronWeb({ env = process.env, fetchImpl = globalThis.fetch, privateKey = '', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const tronGridKey = typeof env.TRONGRID_API_KEY === 'string' ? env.TRONGRID_API_KEY.trim() : ''
  const fullNode = createMainnetRpcProvider({ env, fetchImpl, timeoutMs })
  const solidityNode = createMainnetRpcProvider({ env, fetchImpl, timeoutMs })
  const eventServer = new providers.HttpProvider(
    TRON_MAINNET_RPC,
    timeoutMs,
    '',
    '',
    tronGridKey ? { 'TRON-PRO-API-KEY': tronGridKey } : {},
  )
  return new TronWeb({
    fullNode,
    solidityNode,
    eventServer,
    ...(privateKey ? { privateKey } : {}),
  })
}

export async function postMainnetRead(path, payload, options = {}) {
  const provider = createMainnetRpcProvider(options)
  return provider.request(path, payload, 'post')
}
