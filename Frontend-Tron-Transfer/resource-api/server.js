import http from 'node:http'
import { isIP } from 'node:net'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createFreeDelegationResourceReader } from '../../server/free-delegation-resources.mjs'
import { createRuntimeObservatory } from './runtime-observatory.mjs'
import { createSponsorResourceApi } from './sponsor-api.mjs'
import { createOwnerWalletAuthApi } from './owner-wallet-auth-api.mjs'
import { createSponsorWalletAuthApi } from './sponsor-wallet-auth-api.mjs'
import { createRemoteSponsorSigner } from './remote-sponsor-signer.mjs'

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
    publicFreeDelegationProviders: [{
      id: 'tenergy-mainnet-promo',
      provider: 'TEnergy',
      resource: 'energy',
      access: 'conditional-one-time-promo',
      automation: 'server-to-server-challenge-and-redemption',
      walletApproval: 'required-message-signature',
      transactionRequired: false,
      availability: 'queried-live-from-provider',
      note: 'Only addresses pre-marked eligible by TEnergy can claim while its Mainnet promo is active. Count Energy only after a real on-chain delegation is confirmed.',
    }],
    freeBandwidthProviderStatus: 'no-external-free-bandwidth-delegation-api-verified',
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
      || endpoint.username || endpoint.password || !['', '/', '/jsonrpc'].includes(endpoint.pathname)
      || endpoint.search || endpoint.hash) return TATUM_MAINNET_RPC
    // The resource reader calls Tatum's TRON REST-compatible /wallet endpoints.
    // Render may store the provider's JSON-RPC URL; use its trusted origin here.
    return endpoint.origin
  } catch { return TATUM_MAINNET_RPC }
}

function rpcProviders(env = process.env) {
  const providers = []
  const tatumKey = typeof env.TATUM_API_KEY === 'string' ? env.TATUM_API_KEY.trim() : ''
  const tatumNetwork = String(env.TATUM_TRON_NETWORK || 'mainnet').toLowerCase()
  const tronGridKey = typeof env.TRONGRID_API_KEY === 'string' ? env.TRONGRID_API_KEY.trim() : ''
  if (tatumKey && tatumNetwork === 'mainnet') {
    providers.push({
      id: 'tatum',
      baseUrl: tatumRestBaseUrl(env),
      headers: { 'x-api-key': tatumKey },
    })
  }
  providers.push({
    id: 'trongrid',
    baseUrl: MAINNET_RPC,
    headers: tronGridKey ? { 'TRON-PRO-API-KEY': tronGridKey } : {},
  })
  return providers
}

async function rpcPost(path, body, { fetchImpl = fetch, env = process.env } = {}) {
  let lastError
  for (const provider of rpcProviders(env)) {
    try {
      const response = await fetchImpl(provider.baseUrl + path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...provider.headers,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        redirect: 'error',
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data?.Error || data?.error) {
        const status = response.status || 502
        const detail = String(data?.Error || data?.error || provider.id + ' rejected the read request').slice(0, 240)
        const error = new Error(detail)
        error.status = status
        throw error
      }
      return { data, provider: provider.id }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('No TRON Mainnet RPC provider is configured')
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

export function createServer({ readFreeDelegationStatus, allowedAddress = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp', fetchImpl = fetch, env = process.env, sponsorEngine, sponsorSignerAdapter, sponsorDatabase } = {}) {
  const readDelegationStatus = readFreeDelegationStatus ?? createFreeDelegationResourceReader({ addressValidator: isMainnetAddress, env })
  const runtimeObservatory = createRuntimeObservatory()
  const configuredRemoteSigner = !sponsorSignerAdapter && env.SPONSOR_SIGNER_URL
    ? createRemoteSponsorSigner({ env, fetchImpl })
    : null
  const activeSponsorSigner = sponsorSignerAdapter || configuredRemoteSigner
  const sponsorApi = createSponsorResourceApi({ env, allowedAddress, fetchImpl, ...(sponsorEngine ? { engine: sponsorEngine } : {}), ...(activeSponsorSigner ? { signerAdapter: activeSponsorSigner } : {}), ...(sponsorDatabase ? { getDatabase: sponsorDatabase } : {}), send })
  const ownerWalletAuthApi = createOwnerWalletAuthApi({ env, send })
  const sponsorWalletAuthApi = createSponsorWalletAuthApi({ env, send })
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
        'access-control-allow-headers': 'content-type, authorization, x-sponsor-admin-token, x-owner-enrollment-token, x-sponsor-enrollment-token, x-csrf-token',
        'access-control-max-age': '600',
        vary: 'Origin',
      })
      return res.end()
    }
    const url = new URL(req.url || '/', 'http://localhost')
    if (await ownerWalletAuthApi.handle(req, res, url, origin)) return
    if (await sponsorWalletAuthApi.handle(req, res, url, origin)) return
    if (await sponsorApi.handle(req, res, url, origin)) return
    if (req.method === 'GET' && url.pathname === '/api/observatory/snapshot') {
      const ip = observatoryRateLimitIp(req)
      if (!allowRequest(ip, 'observatory-snapshot', 90)) return send(res, 429, { error: 'RATE_LIMITED', retryAfterSeconds: 60 }, origin)
      return send(res, 200, runtimeObservatory.snapshot(), origin)
    }
    if (req.method === 'GET' && url.pathname === '/api/observatory/transactions') {
      const address = url.searchParams.get('address') || 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
      if (address !== 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp' || !isMainnetAddress(address)) {
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
      const tatumConfigured = typeof env.TATUM_API_KEY === 'string' && env.TATUM_API_KEY.trim().length > 0
      const tronGridConfigured = typeof env.TRONGRID_API_KEY === 'string' && env.TRONGRID_API_KEY.trim().length > 0
      return send(res, 200, {
        ok: true,
        network: 'TRON Mainnet',
        rpc: tatumConfigured
          ? 'Tatum Mainnet API key configured; TronGrid fallback enabled'
          : tronGridConfigured
            ? 'TronGrid API key configured'
            : 'TronGrid public node (no API key configured)',
        rpcProviderPriority: tatumConfigured ? ['tatum', 'trongrid'] : ['trongrid'],
        service: 'tron-transfer-resource-api',
      }, origin)
    }
    if (req.method === 'GET' && url.pathname === '/api/tron/resources/free-delegation/status') {
      const address = typeof url.searchParams.get('address') === 'string' ? url.searchParams.get('address') : ''
      if (address !== allowedAddress || !isMainnetAddress(address)) {
        return send(res, 403, { success: false, error: 'wallet-not-allowed', message: 'This free-delegation policy is restricted to the configured TRON Mainnet owner wallet.' }, origin)
      }
      const refresh = url.searchParams.get('refresh')
      if (refresh !== null && refresh !== '0' && refresh !== '1') return send(res, 400, { success: false, error: 'invalid-refresh' }, origin)
      const ip = observatoryRateLimitIp(req)
      if (!allowRequest(ip, 'free-delegation-resource')) return send(res, 429, { success: false, error: 'RATE_LIMITED', retryAfterSeconds: 60 }, origin)
      const result = await readDelegationStatus(address, { refresh: refresh === '1' })
      return send(res, result.success ? 200 : 503, result, origin)
    }

    const tenergyBase = 'https://api.tenergy.me/v1'
    const tenergyRequest = async (path, method = 'GET', body = undefined) => {
      const response = await fetchImpl(tenergyBase + path, {
        method, headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(8000), redirect: 'error',
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        const providerDetail = payload?.message ?? payload?.error_description ?? payload?.error ?? payload?.code ?? 'TEnergy promotional endpoint rejected the request'
        const detail = typeof providerDetail === 'string' ? providerDetail : (() => { try { return JSON.stringify(providerDetail) } catch { return 'TEnergy promotional endpoint rejected the request' } })()
        const error = new Error(String(detail || 'TEnergy promotional endpoint rejected the request').slice(0, 220))
        error.status = response.status; error.providerCode = payload?.code || payload?.error_code || null; throw error
      }
      return payload
    }
    const promoRoot = '/api/tron/resources/free-delegation/tenergy'
    const promoAliasRoot = '/api/tron/tenergy/promo'
    const legacyPromoMatch = url.pathname.startsWith(promoRoot + '/') ? [url.pathname, url.pathname.slice(promoRoot.length + 1)] : null
    const aliasPromoMatch = url.pathname.startsWith(promoAliasRoot + '/') ? [url.pathname, url.pathname.slice(promoAliasRoot.length + 1)] : null
    const promoMatch = legacyPromoMatch || aliasPromoMatch
    const isPromoAlias = Boolean(aliasPromoMatch)
    const promoAction = !promoMatch ? null : isPromoAlias
      ? ({ status: 'promo', challenge: 'challenge', redeem: 'redeem', redemption: 'redemption' }[promoMatch[1]] || promoMatch[1])
      : promoMatch[1]
    if (promoMatch) {
      let body = null
      if (req.method === 'POST') {
        body = await new Promise(resolveBody => {
          let raw = ''
          req.on('data', chunk => { raw += chunk; if (raw.length > 8192) req.destroy() })
          req.on('end', () => { try { resolveBody(JSON.parse(raw || '{}')) } catch { resolveBody(null) } })
          req.on('error', () => resolveBody(null))
        })
        if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { success: false, error: 'INVALID_JSON_BODY' }, origin)
      }
      if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' }, origin)
      const walletAddress = req.method === 'GET' ? (url.searchParams.get('address') || '') : body.address
      if (walletAddress !== allowedAddress || !isMainnetAddress(walletAddress)) return send(res, 403, { success: false, error: 'wallet-not-allowed' }, origin)
      const ip = observatoryRateLimitIp(req)
      if (!allowRequest(ip, 'tenergy-promo')) return send(res, 429, { success: false, error: 'RATE_LIMITED', retryAfterSeconds: 60 }, origin)
      try {
        if (promoAction === 'promo' && req.method === 'GET') {
          const terms = await tenergyRequest('/promo')
          if (terms.network !== 'mainnet') return send(res, 502, { success: false, error: 'PROVIDER_NETWORK_MISMATCH' }, origin)
          let redemption = null
          try { redemption = await tenergyRequest('/promo/redemptions/' + encodeURIComponent(walletAddress)) }
          catch (error) { if (error.status !== 404) throw error }
          if (isPromoAlias) {
            return send(res, 200, {
              success: true,
              provider: 'TEnergy',
              network: 'mainnet',
              promo: { state: terms.state || 'unknown', grant: terms.grant && typeof terms.grant === 'object' ? terms.grant : null },
              redemption,
              requiresOwnerMessageSignature: !redemption && terms.state === 'active',
              claimSubmitsNoTransaction: true,
              resourceCoverage: { energy: true, bandwidth: false, contractDeploymentFee: false },
              claimMethod: 'wallet-message-signature',
              transactionRequired: false,
            }, origin)
          }
          return send(res, 200, { success: true, provider: 'TEnergy', network: 'mainnet', terms, redemption, claimMethod: 'wallet-message-signature', transactionRequired: false, note: 'One-time promotional Energy only for addresses the provider marked eligible while its Mainnet promotion is active. No paid order or TRX transfer is used.' }, origin)
        }
        if (promoAction === 'challenge' && req.method === 'POST') {
          const terms = await tenergyRequest('/promo')
          if (terms.network !== 'mainnet' || terms.state !== 'active' || !Number(terms.left_today)) return send(res, 409, { success: false, error: 'FREE_PROMO_NOT_ACTIVE', terms }, origin)
          const challenge = await tenergyRequest('/promo/redeem/challenge', 'POST', { address: walletAddress })
          if (challenge.address !== walletAddress || typeof challenge.nonce !== 'string' || typeof challenge.message !== 'string') return send(res, 502, { success: false, error: 'INVALID_PROVIDER_CHALLENGE' }, origin)
          if (isPromoAlias) {
            return send(res, 201, {
              success: true,
              provider: 'TEnergy',
              network: 'mainnet',
              address: challenge.address,
              nonce: challenge.nonce,
              message: challenge.message,
              expiresAt: challenge.expires_at || null,
              approval: 'Sign this exact message in TronLink; this is not a transaction.',
            }, origin)
          }
          return send(res, 201, { success: true, provider: 'TEnergy', network: 'mainnet', challenge, approval: 'Sign this exact message in TronLink; this is not a transaction.' }, origin)
        }
        if (promoAction === 'redeem' && req.method === 'POST') {
          const { nonce, signature } = body
          if (typeof nonce !== 'string' || nonce.length < 8 || nonce.length > 256 || typeof signature !== 'string' || !/^(?:0x)?[0-9a-fA-F]{130}$/.test(signature)) return send(res, 400, { success: false, error: 'INVALID_NONCE_OR_SIGNATURE' }, origin)
          const result = await tenergyRequest('/promo/redeem', 'POST', { address: walletAddress, nonce, signature })
          if (result.address !== walletAddress || !['granting', 'delegated', 'failed'].includes(result.status)) return send(res, 502, { success: false, error: 'INVALID_PROVIDER_REDEMPTION' }, origin)
          return send(res, 201, { success: true, provider: 'TEnergy', network: 'mainnet', redemption: result, verificationPath: promoRoot + '/redemption?address=' + encodeURIComponent(walletAddress) }, origin)
        }
        if (promoAction === 'redemption' && req.method === 'GET') {
          const redemption = await tenergyRequest('/promo/redemptions/' + encodeURIComponent(walletAddress))
          if (redemption.address !== walletAddress) return send(res, 502, { success: false, error: 'PROVIDER_ADDRESS_MISMATCH' }, origin)
          return send(res, 200, { success: true, provider: 'TEnergy', network: 'mainnet', redemption }, origin)
        }
        return send(res, 405, { error: 'METHOD_NOT_ALLOWED' }, origin)
      } catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : 503
        return send(res, status === 429 ? 503 : status, { success: false, provider: 'TEnergy', network: 'mainnet', error: error.providerCode || (status === 404 ? 'PROMO_NOT_REDEEMED' : status === 403 ? 'PROMO_NOT_ELIGIBLE' : status === 409 ? 'PROMO_UNAVAILABLE_OR_ALREADY_REDEEMED' : 'PROVIDER_UNAVAILABLE'), message: String(error.message || 'TEnergy promotional API unavailable').slice(0, 220), retryable: status >= 500 || status === 429 }, origin)
      }
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
      const ip = observatoryRateLimitIp(req)
      if (!allowRequest(ip, 'mainnet-transaction-history')) return send(res, 429, { error: 'RATE_LIMITED', retryAfterSeconds: 15 }, origin)
      try {
        const apiKey = typeof env.TRONGRID_API_KEY === 'string' ? env.TRONGRID_API_KEY.trim() : ''
        const headers = { accept: 'application/json', ...(apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {}) }
        const query = new URLSearchParams({ only_confirmed: 'true', limit: String(requestedLimit), order_by: 'block_timestamp,desc' })
        const trc20Query = new URLSearchParams({ only_confirmed: 'true', limit: String(requestedLimit), order_by: 'block_timestamp,desc', contract_address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' })
        const [nativeResponse, tokenResponse] = await Promise.all([
          fetchImpl(MAINNET_RPC + '/v1/accounts/' + encodeURIComponent(address) + '/transactions?' + query, { method: 'GET', headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS), redirect: 'error' }),
          fetchImpl(MAINNET_RPC + '/v1/accounts/' + encodeURIComponent(address) + '/transactions/trc20?' + trc20Query, { method: 'GET', headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS), redirect: 'error' }).catch(() => null),
        ])
        const [nativePayload, tokenPayload] = await Promise.all([nativeResponse.json().catch(() => ({})), tokenResponse?.json().catch(() => ({})) || Promise.resolve({})])
        if (!nativeResponse.ok || !Array.isArray(nativePayload.data)) throw new Error('TronGrid confirmed native transaction history is unavailable')
        const value = { address, network: 'TRON Mainnet', data: nativePayload.data, trc20Transfers: Array.isArray(tokenPayload.data) ? tokenPayload.data : [], trc20Available: Boolean(tokenResponse?.ok && Array.isArray(tokenPayload.data)), checkedAt: new Date().toISOString(), source: 'trongrid-confirmed-history', tokenContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' }
        cache.set(cacheKey, { at: Date.now(), value })
        return send(res, 200, value, origin)
      } catch {
        return send(res, 503, { error: 'TRON_TRANSACTION_HISTORY_UNAVAILABLE', message: 'Could not read confirmed Sponsor Wallet transaction history from TronGrid.' }, origin)
      }
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' }, origin)
    const match = url.pathname.match(/^\/v1\/resources\/(T[1-9A-HJ-NP-Za-km-z]{33})$/)
    if (!match || !isMainnetAddress(match[1])) return send(res, 400, { error: 'INVALID_TRON_ADDRESS' }, origin)
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
          ? 'Configured TRON Mainnet RPC provider rejected or rate-limited the request. Check its API key and quota; no resource amount has been assumed.'
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
