import http from 'node:http'
import { isIP } from 'node:net'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRuntimeObservatory } from './runtime-observatory.mjs'
import { createSponsorResourceApi } from './sponsor-api.mjs'
import { createOwnerWalletAuthApi } from './owner-wallet-auth-api.mjs'
import { createOwnerOperationApi } from './owner-operation-api.mjs'
import { createTRAXDeploymentApi } from './trax-deployment-api.mjs'
import { createPendingOwnerAcceptanceApi } from './pending-owner-acceptance-api.mjs'
import { createSponsorWalletAuthApi } from './sponsor-wallet-auth-api.mjs'

export const MAINNET_RPC = 'https://api.trongrid.io'
export const TATUM_MAINNET_RPC = 'https://tron-mainnet.gateway.tatum.io'
export const ALLOWED_ORIGINS = new Set([
  'https://tron-transfer.onrender.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
])
const CACHE_TTL_MS = 15_000
const UPSTREAM_TIMEOUT_MS = 8_000
const RATE_WINDOW_MS = 60_000
const RATE_LIMIT = 30
const MAX_RATE_LIMIT_ENTRIES = 10_000
const cache = new Map()
const resourceReadsInFlight = new Map()
const transactionReadsInFlight = new Map()
const mainnetRpcProxyCache = new Map()
const mainnetRpcProxyInFlight = new Map()
const MAINNET_READ_RPC_METHODS = new Set([
  '/wallet/getaccount', '/walletsolidity/getaccount', '/wallet/getaccountresource',
  '/wallet/getaccountnet', '/wallet/getchainparameters', '/wallet/getcontract', '/wallet/getcontractinfo',
  '/wallet/triggerconstantcontract', '/wallet/estimateenergy',
  '/walletsolidity/gettransactionbyid', '/walletsolidity/gettransactioninfobyid',
  '/walletsolidity/getavailableunfreezecount', '/walletsolidity/getcanwithdrawunfreezeamount',
  '/walletsolidity/getcandelegatedmaxsize', '/wallet/getnowblock', '/walletsolidity/getnowblock',
])
let mainnetRpcQueue = Promise.resolve()
let mainnetRpcNextAt = 0
const mainnetRpcCooldownUntilByProvider = new Map()

async function scheduledRpcFetch(fetchImpl, url, options, providerId = 'trongrid') {
  const task = mainnetRpcQueue.then(async () => {
    const cooldownUntil = mainnetRpcCooldownUntilByProvider.get(providerId) || 0
    const waitMs = Math.max(0, mainnetRpcNextAt, cooldownUntil) - Date.now()
    if (waitMs > 0) await new Promise(resolveWait => setTimeout(resolveWait, waitMs))
    const response = await fetchImpl(url, options)
    mainnetRpcNextAt = Date.now() + 550
    if (response.status === 429) {
      const retryAfter = Number(response.headers?.get?.('retry-after'))
      const providerCooldown = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.max(5000, Math.min(30_000, retryAfter * 1000)) : 5000
      mainnetRpcCooldownUntilByProvider.set(providerId, Date.now() + providerCooldown)
    }
    return response
  })
  mainnetRpcQueue = task.catch(() => {})
  return task
}

const number = value => {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}
const available = (limit, used) => Math.max(0, number(limit) - number(used))

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function isMainnetAddress(value) {
  if (typeof value !== 'string' || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value)) return false
  let decoded = 0n
  for (const char of value) {
    const digit = BASE58.indexOf(char)
    if (digit < 0) return false
    decoded = decoded * 58n + BigInt(digit)
  }
  let hex = decoded.toString(16)
  if (hex.length % 2) hex = '0' + hex
  let payload
  try { payload = Buffer.from(hex, 'hex') } catch { return false }
  let leadingZeroes = 0
  while (leadingZeroes < value.length && value[leadingZeroes] === '1') leadingZeroes++
  if (leadingZeroes) payload = Buffer.concat([Buffer.alloc(leadingZeroes), payload])
  if (payload.length !== 25 || payload[0] !== 0x41) return false
  const body = payload.subarray(0, 21)
  const checksum = payload.subarray(21)
  const expected = createHash('sha256').update(createHash('sha256').update(body).digest()).digest().subarray(0, 4)
  return checksum.equals(expected)
}

export function summarizeResources(resource = {}, account = {}, chainParams = []) {
  const byKey = Object.fromEntries((Array.isArray(chainParams) ? chainParams : [])
    .filter(item => item && typeof item.key === 'string')
    .map(item => [item.key, number(item.value)]))
  const energyLimit = number(resource.EnergyLimit)
  const energyUsed = number(resource.EnergyUsed)
  const netLimit = number(resource.NetLimit)
  const netUsed = number(resource.NetUsed)
  const freeNetLimit = number(resource.freeNetLimit)
  const freeNetUsed = number(resource.freeNetUsed)
  const freeEnergy = 0
  const freeBandwidthAvailable = available(freeNetLimit, freeNetUsed)
  const stakedOrDelegatedBandwidthAvailable = available(netLimit, netUsed)
  // Free and staked/delegated Bandwidth are separate coverage sources. TRON
  // does not add them together to cover one transaction: one source must cover
  // the entire byte cost. Keep the aggregate only for multi-transaction
  // reporting, and expose the safe single-transaction coverage separately.
  const maxSingleTransactionAvailable = Math.max(freeBandwidthAvailable, stakedOrDelegatedBandwidthAvailable)
  const availableAcrossSeparateTransactions = freeBandwidthAvailable + stakedOrDelegatedBandwidthAvailable
  return {
    energy: {
      available: available(energyLimit, energyUsed),
      limit: energyLimit,
      used: energyUsed,
      protocolFreeQuota: freeEnergy,
      source: 'staked-or-delegated',
    },
    bandwidth: {
      freeAvailable: freeBandwidthAvailable,
      freeLimit: freeNetLimit,
      freeUsed: freeNetUsed,
      stakedOrDelegatedAvailable: stakedOrDelegatedBandwidthAvailable,
      stakedOrDelegatedLimit: netLimit,
      stakedOrDelegatedUsed: netUsed,
      totalAvailable: availableAcrossSeparateTransactions,
      availableAcrossSeparateTransactions,
      maxSingleTransactionAvailable,
      singleTransactionCoverageRule: 'free and staked/delegated Bandwidth are not combined for one transaction; one source must cover the full byte cost',
    },
    balanceSun: String(account.balance ?? '0'),
    chainParameters: {
      energyFeeSunPerUnit: byKey.getEnergyFee ?? null,
      bandwidthFeeSunPerByte: byKey.getTransactionFee ?? null,
      maxFeeLimitSun: byKey.getMaxFeeLimit ?? null,
      newAccountFeeSun: byKey.getCreateNewAccountFeeInSystemContract ?? null,
    },
    networkResourceWeights: {
      totalEnergyLimit: String(resource.TotalEnergyLimit ?? '0'),
      totalEnergyWeight: String(resource.TotalEnergyWeight ?? '0'),
      totalNetLimit: String(resource.TotalNetLimit ?? '0'),
      totalNetWeight: String(resource.TotalNetWeight ?? '0'),
    },
    freeEnergyAvailable: false,
    publicFreeOffers: [],
    exactDeploymentEnergyEstimate: null,
    estimateNote: 'TRON has no protocol-level free Energy quota. Exact deployment Energy must be estimated for the compiled bytecode and current chain state; the feeLimit is only a maximum cap.',
    checkedAt: new Date().toISOString(),
  }
}

function tatumRestBaseUrl(env = process.env) {
  const configured = typeof env.TATUM_TRON_RPC_URL === 'string' ? env.TATUM_TRON_RPC_URL.trim() : ''
  if (!configured) return TATUM_MAINNET_RPC
  try {
    const endpoint = new URL(configured)
    if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'tron-mainnet.gateway.tatum.io'
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return TATUM_MAINNET_RPC
    return endpoint.origin
  } catch { return TATUM_MAINNET_RPC }
}

function rpcProviders(env = process.env) {
  const providers = []
  const tatumKey = typeof env.TATUM_API_KEY === 'string' ? env.TATUM_API_KEY.trim() : ''
  if (tatumKey && String(env.TATUM_TRON_NETWORK || 'mainnet').toLowerCase() === 'mainnet') {
    providers.push({ id: 'tatum', baseUrl: tatumRestBaseUrl(env), headers: { 'x-api-key': tatumKey } })
  }
  const tronGridKey = typeof env.TRONGRID_API_KEY === 'string' ? env.TRONGRID_API_KEY.trim() : ''
  providers.push({
    id: 'trongrid',
    baseUrl: MAINNET_RPC,
    headers: tronGridKey ? { 'TRON-PRO-API-KEY': tronGridKey } : {},
  })
  return providers
}

async function rpcPost(path, body, { fetchImpl = fetch, env = process.env } = {}) {
  let lastError
  for (const node of rpcProviders(env)) {
    try {
      const response = await scheduledRpcFetch(fetchImpl, node.baseUrl + path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...node.headers,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        redirect: 'error',
      }, node.id)
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data?.Error || data?.error) {
        const error = new Error(String(data?.Error || data?.error || (node.id + ' rejected the Mainnet read request')).slice(0, 240))
        error.status = response.status || 502
        throw error
      }
      return { data, provider: node.id }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('No TRON Mainnet RPC provider is configured.')
}

async function readResources(address, options = {}) {
  const [resourceResult, accountResult, parameterResult] = await Promise.all([
    rpcPost('/wallet/getaccountresource', { address, visible: true }, options),
    rpcPost('/wallet/getaccount', { address, visible: true }, options),
    rpcPost('/wallet/getchainparameters', {}, options),
  ])
  return {
    ...summarizeResources(resourceResult.data, accountResult.data, parameterResult.data?.chainParameter || []),
    rpc: {
      preferredProviderOrder: rpcProviders(options.env).map(provider => provider.id),
      providersUsed: {
        accountResources: resourceResult.provider,
        account: accountResult.provider,
        chainParameters: parameterResult.provider,
      },
    },
  }
}

export function createBoundedRateLimiter({
  windowMs = RATE_WINDOW_MS,
  maxEntries = MAX_RATE_LIMIT_ENTRIES,
  now = Date.now,
} = {}) {
  if (!Number.isInteger(windowMs) || windowMs < 1) throw new TypeError('windowMs must be a positive integer')
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new TypeError('maxEntries must be a positive integer')
  const entries = new Map()
  let requestsSinceSweep = 0

  function removeExpired(timestamp) {
    for (const [key, entry] of entries) {
      if (timestamp - entry.startedAt >= windowMs) entries.delete(key)
    }
  }

  function allow(key, limit = RATE_LIMIT) {
    const timestamp = now()
    requestsSinceSweep += 1
    if (requestsSinceSweep >= 256) {
      removeExpired(timestamp)
      requestsSinceSweep = 0
    }

    const entry = entries.get(key)
    if (entry && timestamp - entry.startedAt < windowMs) {
      entry.count += 1
      return entry.count <= limit
    }
    if (entry) entries.delete(key)

    if (entries.size >= maxEntries) removeExpired(timestamp)
    // Fail closed at capacity. Never evict an active caller's counter to make
    // room for a new identity, which would let address rotation reset limits.
    if (entries.size >= maxEntries) return false
    entries.set(key, { startedAt: timestamp, count: 1 })
    return true
  }

  Object.defineProperties(allow, {
    size: { get: () => entries.size },
    clear: { value: () => { entries.clear(); requestsSinceSweep = 0 } },
  })
  return allow
}

// Render routes public traffic through Cloudflare. Prefer its single-address
// CF-Connecting-IP header; unlike caller-controlled X-Forwarded-For prefixes,
// Cloudflare overwrites this header at its edge. Fall back to the TCP peer
// outside that deployment path.
function observatoryRateLimitIp(req) {
  const cloudflareIp = typeof req.headers['cf-connecting-ip'] === 'string'
    ? req.headers['cf-connecting-ip'].trim()
    : ''
  if (isIP(cloudflareIp)) return cloudflareIp
  return req.socket?.remoteAddress || 'unknown'
}

function send(res, status, payload, origin) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  }
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers['access-control-allow-origin'] = origin
    headers['access-control-allow-credentials'] = 'true'
    headers.vary = 'Origin'
  }
  res.writeHead(status, headers)
  res.end(JSON.stringify(payload))
}

export function createServer({ env = process.env, allowedAddress = env.TRON_OWNER_ADDRESS || env.TRON_OWNER_WALLET_ADDRESS || '', fetchImpl = fetch, sponsorEngine, sponsorDatabase } = {}) {
  const runtimeObservatory = createRuntimeObservatory()
  const ownerWalletAuthApi = createOwnerWalletAuthApi({ env, send })
  const ownerOperationApi = createOwnerOperationApi({
    env, send, fetchImpl, database: sponsorDatabase || null,
    authenticateManagedSession: (req, options) => ownerWalletAuthApi.authenticateRequest(req, options),
  })
  const traxDeploymentApi = createTRAXDeploymentApi({
    env, send, database: sponsorDatabase || null,
    authenticateManagedSession: (req, options) => ownerWalletAuthApi.authenticateRequest(req, options),
  })
  const pendingOwnerAcceptanceApi = createPendingOwnerAcceptanceApi({ env, send, database: sponsorDatabase || null })
  const sponsorWalletAuthApi = createSponsorWalletAuthApi({ env, send })
  const sponsorApi = createSponsorResourceApi({
    env, allowedAddress, fetchImpl,
    ...(sponsorEngine ? { engine: sponsorEngine } : {}),
    ...(sponsorDatabase ? { getDatabase: sponsorDatabase } : {}),
    authenticateManagedSession: (req, options) => sponsorWalletAuthApi.authenticateRequest(req, options),
    authenticateOwnerAdminSession: (req, options) => ownerWalletAuthApi.authenticateRequest(req, options),
    send,
  })
  const rateLimiters = new Map()
  let uptimeHistoryCache = { at: 0, value: null }
  let renderMetricsCache = { at: 0, value: null }
  const allowRequest = (ip, scope = 'default', limit = RATE_LIMIT) => {
    let limiter = rateLimiters.get(scope)
    if (!limiter) {
      // Keep the number of independently budgeted scopes bounded as well.
      if (rateLimiters.size >= 32) return false
      limiter = createBoundedRateLimiter()
      rateLimiters.set(scope, limiter)
    }
    return limiter(ip, limit)
  }
  const server = http.createServer(async (req, res) => {
    const requestStartedAt = performance.now()
    const originalEnd = res.end.bind(res)
    let requestRecorded = false
    res.end = (...args) => {
      if (!requestRecorded) {
        requestRecorded = true
        const requestPath = new URL(req.url || '/', 'http://localhost').pathname
        runtimeObservatory.recordHttpRequest({ method: req.method, path: requestPath, statusCode: res.statusCode, durationMs: performance.now() - requestStartedAt })
      }
      return originalEnd(...args)
    }
    const origin = req.headers.origin
    if (origin && !ALLOWED_ORIGINS.has(origin)) return send(res, 403, { error: 'ORIGIN_NOT_ALLOWED' })
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': origin || 'null',
        'access-control-allow-credentials': 'true',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, authorization, x-owner-enrollment-token, x-sponsor-enrollment-token, x-csrf-token, x-owner-csrf-token',
        'access-control-max-age': '600',
        vary: 'Origin',
      })
      return res.end()
    }
    const url = new URL(req.url || '/', 'http://localhost')
    const rpcProxyMatch = url.pathname.match(/^\/api\/tron\/mainnet\/rpc(\/wallet(?:solidity)?\/[a-zA-Z0-9]+)$/)
    if (rpcProxyMatch) {
      if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' }, origin)
      const rpcPath = rpcProxyMatch[1]
      if (!MAINNET_READ_RPC_METHODS.has(rpcPath)) return send(res, 404, { error: 'MAINNET_RPC_METHOD_NOT_ALLOWED' }, origin)
      const ip = observatoryRateLimitIp(req)
      if (!allowRequest(ip, 'mainnet-rpc-proxy', 120)) return send(res, 429, { error: 'RATE_LIMITED', retryAfterSeconds: 15 }, origin)
      let raw = ''
      try {
        for await (const chunk of req) {
          raw += chunk.toString('utf8')
          if (raw.length > 32_768) return send(res, 413, { error: 'RPC_REQUEST_TOO_LARGE' }, origin)
        }
        const body = JSON.parse(raw || '{}')
        if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'INVALID_RPC_REQUEST' }, origin)
        const key = rpcPath + ':' + JSON.stringify(body)
        const cached = mainnetRpcProxyCache.get(key)
        if (cached && Date.now() - cached.at < 1500) return send(res, 200, cached.value, origin)
        let pending = mainnetRpcProxyInFlight.get(key)
        if (!pending) {
          pending = rpcPost(rpcPath, body, { fetchImpl, env }).then(result => result.data)
          mainnetRpcProxyInFlight.set(key, pending)
        }
        try {
          const value = await pending
          mainnetRpcProxyCache.set(key, { at: Date.now(), value })
          return send(res, 200, value, origin)
        } finally {
          if (mainnetRpcProxyInFlight.get(key) === pending) mainnetRpcProxyInFlight.delete(key)
        }
      } catch (error) {
        const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 503
        return send(res, status === 429 ? 503 : status, {
          Error: status === 429 ? 'TRON Mainnet provider is rate-limited; retry after cooldown.' : 'TRON Mainnet RPC is temporarily unavailable.',
          code: status === 401 || status === 403 ? 'MAINNET_RPC_PROVIDER_AUTH_FAILED' : status === 429 ? 'MAINNET_RPC_RATE_LIMITED' : 'MAINNET_RPC_UNAVAILABLE',
          retryAfterSeconds: status === 429 ? 5 : undefined,
        }, origin)
      }
    }
    if (await ownerWalletAuthApi.handle(req, res, url, origin)) return
    if (await ownerOperationApi.handle(req, res, url, origin)) return
    if (await traxDeploymentApi.handle(req, res, url, origin)) return
    if (await pendingOwnerAcceptanceApi.handle(req, res, url, origin)) return
    if (await sponsorWalletAuthApi.handle(req, res, url, origin)) return
    if (await sponsorApi.handle(req, res, url, origin)) return
    if (req.method === 'GET' && url.pathname === '/api/observatory/snapshot') {
      const ip = observatoryRateLimitIp(req)
      if (!allowRequest(ip, 'observatory-snapshot', 90)) return send(res, 429, { error: 'RATE_LIMITED', retryAfterSeconds: 60 }, origin)
      return send(res, 200, runtimeObservatory.snapshot(), origin)
    }
    if (req.method === 'GET' && url.pathname === '/api/observatory/transactions') {
      const address = url.searchParams.get('address') || allowedAddress
      if (!allowedAddress || address !== allowedAddress || !isMainnetAddress(address)) {
        return send(res, 403, { success: false, error: 'wallet-not-allowed' }, origin)
      }
      const ip = observatoryRateLimitIp(req)
      if (!allowRequest(ip, 'observatory-transactions')) return send(res, 429, { success: false, error: 'RATE_LIMITED', retryAfterSeconds: 60 }, origin)
      try {
        const query = new URLSearchParams({ only_confirmed: 'true', limit: '20', order_by: 'block_timestamp,desc' })
        const tronGridKey = typeof env.TRONGRID_API_KEY === 'string' ? env.TRONGRID_API_KEY.trim() : ''
        const response = await fetchImpl(`https://api.trongrid.io/v1/accounts/${encodeURIComponent(address)}/transactions?${query}`, {
          method: 'GET',
          headers: { accept: 'application/json', ...(tronGridKey ? { 'TRON-PRO-API-KEY': tronGridKey } : {}) },
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          redirect: 'error',
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok || data?.success === false) throw new Error(`TronGrid transaction history returned HTTP ${response.status}`)
        const transactions = Array.isArray(data.data) ? data.data : []
        return send(res, 200, { success: true, network: 'TRON Mainnet', address, provider: 'trongrid-v1', confirmedOnly: true, transactions, checkedAt: new Date().toISOString() }, origin)
      } catch (error) {
        return send(res, 503, { success: false, error: 'MAINNET_TRANSACTION_FEED_UNAVAILABLE', message: String(error?.message || 'Could not read confirmed Mainnet transactions').slice(0, 180) }, origin)
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/observatory/render-events') {
      const ip = observatoryRateLimitIp(req)
      if (!allowRequest(ip, 'observatory-render-events', 10)) return send(res, 429, { success: false, error: 'RATE_LIMITED', retryAfterSeconds: 60 }, origin)
      const apiKey = typeof env.RENDER_API_KEY === 'string' ? env.RENDER_API_KEY.trim() : ''
      const services = [
        { id: env.RENDER_RESOURCE_API_SERVICE_ID || 'srv-dbrjpq56e07s73bueevg', label: 'Resource API' },
        { id: env.RENDER_FRONTEND_SERVICE_ID || 'srv-dblmrad6e07s739cs2lg', label: 'Owner frontend' },
      ]
      if (!apiKey) return send(res, 200, { success: true, configured: false, provider: 'Render API', services: [], events: [], checkedAt: new Date().toISOString(), note: 'Set RENDER_API_KEY on the resource API service to enable authenticated Render control-plane events.' }, origin)
      try {
        const results = await Promise.all(services.map(async service => {
          const query = new URLSearchParams({ limit: '10' })
          const response = await fetchImpl('https://api.render.com/v1/services/' + encodeURIComponent(service.id) + '/events?' + query, {
            method: 'GET',
            headers: { accept: 'application/json', authorization: 'Bearer ' + apiKey },
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
            redirect: 'error',
          })
          if (!response.ok) throw new Error('Render events API returned HTTP ' + response.status)
          const rows = await response.json()
          return (Array.isArray(rows) ? rows : []).map(row => {
            const event = row?.event || row || {}
            return { id: String(event.id || ''), serviceId: service.id, serviceLabel: service.label, type: String(event.type || 'unknown').slice(0, 64), timestamp: event.timestamp || null }
          }).filter(event => event.id && event.timestamp)
        }))
        const events = results.flat().sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)).slice(0, 20)
        return send(res, 200, { success: true, configured: true, provider: 'Render API', services: services.map(({ id, label }) => ({ id, label })), events, checkedAt: new Date().toISOString() }, origin)
      } catch (error) {
        return send(res, 503, { success: false, configured: true, error: 'RENDER_EVENTS_UNAVAILABLE', message: String(error?.message || 'Render control-plane events unavailable').slice(0, 160), checkedAt: new Date().toISOString() }, origin)
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/observatory/uptime-history') {
      const ip = observatoryRateLimitIp(req)
      if (!allowRequest(ip, 'observatory-uptime-history', 10)) return send(res, 429, { success: false, error: 'RATE_LIMITED', retryAfterSeconds: 60 }, origin)
      if (uptimeHistoryCache.value && Date.now() - uptimeHistoryCache.at < 60_000) {
        return send(res, 200, uptimeHistoryCache.value, origin)
      }
      try {
        const today = new Date()
        const dates = [0, 1].map(offset => {
          const date = new Date(today)
          date.setUTCDate(date.getUTCDate() - offset)
          return date.toISOString().slice(0, 10)
        })
        const documents = await Promise.all(dates.map(async date => {
          const archiveUrl = 'https://raw.githubusercontent.com/MyTeleProject2026/trc20-usdt-token-cloner/monitoring-history/history/' + date + '.json'
          const response = await fetchImpl(archiveUrl, {
            method: 'GET',
            headers: { accept: 'application/json', 'user-agent': 'tron-transfer-runtime-observatory' },
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
            redirect: 'error',
          })
          if (response.status === 404) return { date, records: [] }
          if (!response.ok) throw new Error('Git-backed uptime history returned HTTP ' + response.status)
          const document = await response.json()
          if (!Array.isArray(document?.records)) throw new Error('Git-backed uptime history has an invalid records array')
          return { date, records: document.records }
        }))
        const records = documents.flatMap(document => document.records)
          .filter(record => record && Number.isFinite(Number(record.id)) && typeof record.checkedAt === 'string')
          .sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt))
          .slice(0, 50)
        const runs = records.map(record => ({
          id: Number(record.id),
          runNumber: Number(record.runNumber) || null,
          status: 'completed',
          conclusion: record.conclusion === 'success' ? 'success' : 'failure',
          createdAt: record.checkedAt,
          updatedAt: record.checkedAt,
          url: typeof record.url === 'string' && /^https:\/\/github\.com\/MyTeleProject2026\/trc20-usdt-token-cloner\/actions\/runs\/\d+$/.test(record.url) ? record.url : null,
          commit: typeof record.commit === 'string' ? record.commit.slice(0, 12) : null,
          event: String(record.event || 'unknown').slice(0, 24),
          results: (Array.isArray(record.results) ? record.results : []).slice(0, 5).map(item => ({
            name: String(item.name || '').slice(0, 80),
            ok: item.ok === true,
            status: Number(item.status) || 0,
            latencyMs: Math.max(0, Number(item.latencyMs) || 0),
            detail: String(item.detail || '').replace(/[\r\n]/g, ' ').slice(0, 240),
            metrics: item.metrics && typeof item.metrics === 'object' ? {
              uptimeSeconds: Math.max(0, Number(item.metrics.uptimeSeconds) || 0),
              heartbeatSuccessPercent: Math.min(100, Math.max(0, Number(item.metrics.heartbeatSuccessPercent) || 0)),
              heartbeatMissedIntervals: Math.max(0, Number(item.metrics.heartbeatMissedIntervals) || 0),
              rssBytes: Math.max(0, Number(item.metrics.rssBytes) || 0),
              heapUsedBytes: Math.max(0, Number(item.metrics.heapUsedBytes) || 0),
              heapTotalBytes: Math.max(0, Number(item.metrics.heapTotalBytes) || 0),
              eventLoopP95Ms: Math.max(0, Number(item.metrics.eventLoopP95Ms) || 0),
              requestCount: Math.max(0, Number(item.metrics.requestCount) || 0),
              errors5xx: Math.max(0, Number(item.metrics.errors5xx) || 0),
              errorRatePercent: Math.min(100, Math.max(0, Number(item.metrics.errorRatePercent) || 0)),
              averageLatencyMs: Math.max(0, Number(item.metrics.averageLatencyMs) || 0),
              p95LatencyMs: Math.max(0, Number(item.metrics.p95LatencyMs) || 0),
            } : null,
            checkedAt: typeof item.checkedAt === 'string' ? item.checkedAt : record.checkedAt,
          })),
        }))
        const value = {
          success: true,
          provider: 'Git-backed GitHub history',
          storage: 'monitoring-history branch',
          retentionDays: null,
          totalRecords: documents.reduce((sum, document) => sum + document.records.length, 0),
          workflowUrl: 'https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/actions/workflows/tron-transfer-production-uptime.yml',
          runs,
          checkedAt: new Date().toISOString(),
          note: 'Persistent daily probe records are stored in the repository monitoring-history branch. Git commit history preserves previous versions; recent detailed workflow artifacts remain available for 90 days.',
        }
        uptimeHistoryCache = { at: Date.now(), value }
        return send(res, 200, value, origin)
      } catch (error) {
        return send(res, 503, { success: false, error: 'UPTIME_HISTORY_UNAVAILABLE', message: String(error?.message || 'Git-backed uptime history unavailable').slice(0, 160) }, origin)
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/observatory/render-metrics') {
      const ip = observatoryRateLimitIp(req)
      if (!allowRequest(ip, 'observatory-render-metrics', 10)) return send(res, 429, { success: false, error: 'RATE_LIMITED', retryAfterSeconds: 60 }, origin)
      if (renderMetricsCache.value && Date.now() - renderMetricsCache.at < 300_000) {
        return send(res, 200, renderMetricsCache.value, origin)
      }
      const apiKey = typeof env.RENDER_API_KEY === 'string' ? env.RENDER_API_KEY.trim() : ''
      if (!apiKey) return send(res, 200, {
        success: true, configured: false, provider: 'Render Metrics API', metrics: [],
        checkedAt: new Date().toISOString(),
        note: 'Set a newly rotated RENDER_API_KEY as a server-side secret to enable Render platform metrics.',
      }, origin)
      const resourceApiId = env.RENDER_RESOURCE_API_SERVICE_ID || 'srv-dbrjpq56e07s73bueevg'
      const frontendId = env.RENDER_FRONTEND_SERVICE_ID || 'srv-dblmrad6e07s739cs2lg'
      const endTime = new Date().toISOString()
      const startTime = new Date(Date.now() - 60 * 60 * 1000).toISOString()
      const metricSpecs = [
        { id: 'cpu', label: 'CPU usage', path: '/metrics/cpu', resources: [resourceApiId] },
        { id: 'memory', label: 'Memory usage', path: '/metrics/memory', resources: [resourceApiId] },
        { id: 'bandwidth', label: 'Outbound bandwidth', path: '/metrics/bandwidth', resources: [resourceApiId, frontendId] },
        { id: 'http_requests', label: 'HTTP requests', path: '/metrics/http-requests', resources: [resourceApiId] },
        { id: 'http_latency', label: 'HTTP latency p95', path: '/metrics/http-latency', resources: [resourceApiId], extras: { quantile: '0.95' } },
      ]
      const normalizeRows = rows => (Array.isArray(rows) ? rows : []).flatMap(row => {
        const labels = Object.fromEntries((Array.isArray(row?.labels) ? row.labels : [])
          .filter(label => label && typeof label.field === 'string')
          .map(label => [label.field, String(label.value)]))
        return (Array.isArray(row?.values) ? row.values : []).map(point => ({
          timestamp: point.timestamp || null,
          value: Number.isFinite(Number(point.value)) ? Number(point.value) : null,
          unit: typeof row.unit === 'string' ? row.unit : null,
          resourceId: labels.service || labels.resource || null,
          instanceId: labels.instance || null,
          statusCode: labels.statusCode || labels.status_code || null,
          quantile: labels.quantile || null,
        })).filter(point => point.timestamp && point.value !== null)
      })
      const metrics = await Promise.all(metricSpecs.map(async spec => {
        const query = new URLSearchParams({ startTime, endTime, ...(spec.id === 'bandwidth' ? {} : { resolutionSeconds: '300' }), ...spec.extras })
        for (const resource of spec.resources) query.append('resource', resource)
        try {
          const response = await fetchImpl('https://api.render.com/v1' + spec.path + '?' + query, {
            method: 'GET',
            headers: { accept: 'application/json', authorization: 'Bearer ' + apiKey },
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
            redirect: 'error',
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) return { id: spec.id, label: spec.label, state: 'unavailable', points: [], note: 'Render API returned HTTP ' + response.status }
          const points = normalizeRows(Array.isArray(payload) ? payload : payload.data)
          return { id: spec.id, label: spec.label, state: points.length ? 'available' : 'no_data', points }
        } catch (error) {
          return { id: spec.id, label: spec.label, state: 'unavailable', points: [], note: String(error?.message || 'Render metrics unavailable').slice(0, 120) }
        }
      }))
      const availableCount = metrics.filter(metric => metric.state !== 'unavailable').length
      if (!availableCount) return send(res, 503, { success: false, configured: true, error: 'RENDER_METRICS_UNAVAILABLE', metrics, checkedAt: new Date().toISOString() }, origin)
      const value = {
        success: true, configured: true, provider: 'Render Metrics API',
        window: { startTime, endTime, resolutionSeconds: 300 },
        metrics, checkedAt: new Date().toISOString(),
        note: 'Render platform metrics use the platform sampling interval. Empty or unsupported metrics are shown as unavailable; process heartbeat values are reported separately.',
      }
      renderMetricsCache = { at: Date.now(), value }
      return send(res, 200, value, origin)
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      const providers = rpcProviders(env)
      const tatumConfigured = providers.some(provider => provider.id === 'tatum')
      const tronGridConfigured = typeof env.TRONGRID_API_KEY === 'string' && env.TRONGRID_API_KEY.trim().length > 0
      return send(res, 200, {
        ok: true,
        network: 'TRON Mainnet',
        rpc: tatumConfigured ? 'Tatum Mainnet primary with TronGrid fallback' : (tronGridConfigured ? 'TronGrid Mainnet node API key configured' : 'TronGrid public Mainnet node'),
        rpcNode: providers[0]?.id || 'trongrid',
        rpcProviderPriority: providers.map(provider => provider.id),
        service: 'tron-transfer-resource-api',
      }, origin)
    }
    const transactionsMatch = url.pathname.match(/^\/v1\/transactions\/([^/]+)$/)
    if (transactionsMatch) {
      if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' }, origin)
      const address = transactionsMatch[1]
      if (!isMainnetAddress(address)) return send(res, 400, { error: 'INVALID_TRON_ADDRESS' }, origin)
      const requestedLimit = Number(url.searchParams.get('limit') || 20)
      if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 50) return send(res, 400, { error: 'INVALID_LIMIT', message: 'limit must be an integer between 1 and 50' }, origin)
      // Confirmed history is cached by address and page size. Reuse a fresh
      // snapshot before consuming the provider-miss rate budget.
      const cacheKey = 'transactions:' + address + ':' + requestedLimit
      const cached = cache.get(cacheKey)
      if (cached && Date.now() - cached.at < CACHE_TTL_MS) return send(res, 200, cached.value, origin)
      const inFlight = transactionReadsInFlight.get(cacheKey)
      if (inFlight) {
        try { return send(res, 200, await inFlight, origin) }
        catch { return send(res, 503, { error: 'TRON_TRANSACTION_HISTORY_UNAVAILABLE', message: 'Confirmed Mainnet transaction history is temporarily unavailable.' }, origin) }
      }
      const ip = observatoryRateLimitIp(req)
      if (!allowRequest(ip, 'mainnet-transaction-history')) return send(res, 429, { error: 'RATE_LIMITED', retryAfterSeconds: 15 }, origin)
      const readPromise = (async () => {
        const apiKey = typeof env.TRONGRID_API_KEY === 'string' ? env.TRONGRID_API_KEY.trim() : ''
        const headers = { accept: 'application/json', ...(apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {}) }
        const query = new URLSearchParams({ only_confirmed: 'true', limit: String(requestedLimit), order_by: 'block_timestamp,desc' })
        const trc20Query = new URLSearchParams({ only_confirmed: 'true', limit: String(requestedLimit), order_by: 'block_timestamp,desc', contract_address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' })
        const [nativeResponse, tokenResponse] = await Promise.all([
          scheduledRpcFetch(fetchImpl, MAINNET_RPC + '/v1/accounts/' + encodeURIComponent(address) + '/transactions?' + query, { method: 'GET', headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS), redirect: 'error' }),
          scheduledRpcFetch(fetchImpl, MAINNET_RPC + '/v1/accounts/' + encodeURIComponent(address) + '/transactions/trc20?' + trc20Query, { method: 'GET', headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS), redirect: 'error' }).catch(() => null),
        ])
        const [nativePayload, tokenPayload] = await Promise.all([nativeResponse.json().catch(() => ({})), tokenResponse?.json().catch(() => ({})) || Promise.resolve({})])
        if (!nativeResponse.ok || !Array.isArray(nativePayload.data)) throw new Error('TronGrid confirmed native transaction history is unavailable')
        return { address, network: 'TRON Mainnet', data: nativePayload.data, trc20Transfers: Array.isArray(tokenPayload.data) ? tokenPayload.data : [], trc20Available: Boolean(tokenResponse?.ok && Array.isArray(tokenPayload.data)), checkedAt: new Date().toISOString(), source: 'trongrid-confirmed-history', tokenContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' }
      })()
      transactionReadsInFlight.set(cacheKey, readPromise)
      try {
        const value = await readPromise
        cache.set(cacheKey, { at: Date.now(), value })
        return send(res, 200, value, origin)
      } catch {
        return send(res, 503, { error: 'TRON_TRANSACTION_HISTORY_UNAVAILABLE', message: 'Could not read confirmed Mainnet transaction history from TronGrid.' }, origin)
      } finally {
        if (transactionReadsInFlight.get(cacheKey) === readPromise) transactionReadsInFlight.delete(cacheKey)
      }
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' }, origin)
    const match = url.pathname.match(/^\/v1\/resources\/([^/]+)$/)
    if (!match) return send(res, 404, { error: 'NOT_FOUND' }, origin)
    if (!isMainnetAddress(match[1])) return send(res, 400, { error: 'INVALID_TRON_ADDRESS' }, origin)
    const address = match[1]
    // Serve fresh cache hits before applying the per-IP miss budget. Dashboard
    // refreshes can legitimately request the same address from multiple widgets.
    const cached = cache.get(address)
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return send(res, 200, { address, network: 'TRON Mainnet', ...cached.value }, origin)

    // Coalesce concurrent cache misses for the same address so a single UI
    // refresh cannot fan out into duplicate provider RPC requests.
    const inFlight = resourceReadsInFlight.get(address)
    if (inFlight) {
      try {
        const value = await inFlight
        return send(res, 200, { address, network: 'TRON Mainnet', ...value }, origin)
      } catch (error) {
        const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 503
        return send(res, status === 429 ? 503 : status, {
          error: status === 401 || status === 403 || status === 429 ? 'PUBLIC_RPC_LIMITED' : 'TRON_RPC_UNAVAILABLE',
          message: 'The shared Mainnet resource read is temporarily unavailable. Retry after the indicated delay; no resource amount has been assumed.',
          retryAfterSeconds: 15,
        }, origin)
      }
    }

    const ip = observatoryRateLimitIp(req)
    if (!allowRequest(ip, 'mainnet-resource-read')) return send(res, 429, { error: 'RATE_LIMITED', retryAfterSeconds: 15 }, origin)
    const readPromise = readResources(address, { fetchImpl, env })
    resourceReadsInFlight.set(address, readPromise)
    try {
      const value = await readPromise
      cache.set(address, { at: Date.now(), value })
      return send(res, 200, { address, network: 'TRON Mainnet', ...value }, origin)
    } catch (error) {
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 503
      const isAuthOrRate = status === 401 || status === 403 || status === 429
      return send(res, status === 429 ? 503 : status, {
        error: isAuthOrRate ? 'PUBLIC_RPC_LIMITED' : 'TRON_RPC_UNAVAILABLE',
        message: isAuthOrRate
          ? 'Tatum and TronGrid Mainnet RPC reads failed or were rate-limited. Check configured RPC credentials and quotas; no resource amount has been assumed.'
          : 'Could not read current Mainnet resources from Tatum or TronGrid. No resource amount has been assumed.',
      }, origin)
    } finally {
      if (resourceReadsInFlight.get(address) === readPromise) resourceReadsInFlight.delete(address)
    }
  })
  server.on('close', () => runtimeObservatory.stop())
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 10000)
  createServer().listen(port, '0.0.0.0', () => {
    process.stdout.write('TRON resource API listening on ' + port + '\n')
  })
}
