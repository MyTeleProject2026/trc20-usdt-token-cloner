import http from 'node:http'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createFreeDelegationResourceReader } from '../../server/free-delegation-resources.mjs'

export const MAINNET_RPC = 'https://api.trongrid.io'
export const ALLOWED_ORIGINS = new Set([
  'https://tron-transfer.onrender.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
])
const CACHE_TTL_MS = 15_000
const UPSTREAM_TIMEOUT_MS = 8_000
const RATE_WINDOW_MS = 60_000
const RATE_LIMIT = 30
const cache = new Map()
const rate = new Map()

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
  return {
    energy: {
      available: available(energyLimit, energyUsed),
      limit: energyLimit,
      used: energyUsed,
      protocolFreeQuota: freeEnergy,
      source: 'staked-or-delegated',
    },
    bandwidth: {
      freeAvailable: available(freeNetLimit, freeNetUsed),
      freeLimit: freeNetLimit,
      freeUsed: freeNetUsed,
      stakedOrDelegatedAvailable: available(netLimit, netUsed),
      stakedOrDelegatedLimit: netLimit,
      stakedOrDelegatedUsed: netUsed,
      totalAvailable: available(freeNetLimit, freeNetUsed) + available(netLimit, netUsed),
    },
    balanceSun: String(account.balance ?? '0'),
    chainParameters: {
      energyFeeSunPerUnit: byKey.getEnergyFee ?? null,
      bandwidthFeeSunPerByte: byKey.getTransactionFee ?? null,
      maxFeeLimitSun: byKey.getMaxFeeLimit ?? null,
      newAccountFeeSun: byKey.getCreateNewAccountFeeInSystemContract ?? null,
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

async function rpcPost(path, body) {
  const response = await fetch(MAINNET_RPC + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data?.Error || data?.error) {
    const status = response.status || 502
    const detail = String(data?.Error || data?.error || 'TRON node rejected the read request').slice(0, 240)
    const error = new Error(detail)
    error.status = status
    throw error
  }
  return data
}

async function readResources(address) {
  const [resource, account, parameters] = await Promise.all([
    rpcPost('/wallet/getaccountresource', { address, visible: true }),
    rpcPost('/wallet/getaccount', { address, visible: true }),
    rpcPost('/wallet/getchainparameters', {}),
  ])
  return summarizeResources(resource, account, parameters?.chainParameter || [])
}

function allowRequest(ip) {
  const now = Date.now()
  const entry = rate.get(ip)
  if (!entry || now - entry.startedAt >= RATE_WINDOW_MS) {
    rate.set(ip, { startedAt: now, count: 1 })
    return true
  }
  entry.count += 1
  return entry.count <= RATE_LIMIT
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
    headers.vary = 'Origin'
  }
  res.writeHead(status, headers)
  res.end(JSON.stringify(payload))
}

export function createServer({ readFreeDelegationStatus = createFreeDelegationResourceReader({ addressValidator: isMainnetAddress }), allowedAddress = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp', fetchImpl = fetch } = {}) {
  return http.createServer(async (req, res) => {
    const origin = req.headers.origin
    if (origin && !ALLOWED_ORIGINS.has(origin)) return send(res, 403, { error: 'ORIGIN_NOT_ALLOWED' })
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': origin || 'null',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
        vary: 'Origin',
      })
      return res.end()
    }
    const url = new URL(req.url || '/', 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true, network: 'TRON Mainnet', rpc: 'TronGrid public node (no API key configured)', service: 'tron-transfer-resource-api' }, origin)
    }
    if (req.method === 'GET' && url.pathname === '/api/tron/resources/free-delegation/status') {
      const address = typeof url.searchParams.get('address') === 'string' ? url.searchParams.get('address') : ''
      if (address !== allowedAddress || !isMainnetAddress(address)) {
        return send(res, 403, { success: false, error: 'wallet-not-allowed', message: 'This free-delegation policy is restricted to the configured TRON Mainnet owner wallet.' }, origin)
      }
      const refresh = url.searchParams.get('refresh')
      if (refresh !== null && refresh !== '0' && refresh !== '1') return send(res, 400, { success: false, error: 'invalid-refresh' }, origin)
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim()
      if (!allowRequest(ip)) return send(res, 429, { success: false, error: 'RATE_LIMITED', retryAfterSeconds: 60 }, origin)
      const result = await readFreeDelegationStatus(address, { refresh: refresh === '1' })
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
        const error = new Error(String(payload?.message || payload?.error || 'TEnergy promotional endpoint rejected the request').slice(0, 220))
        error.status = response.status; error.providerCode = payload?.code || payload?.error_code || null; throw error
      }
      return payload
    }
    const promoRoot = '/api/tron/resources/free-delegation/tenergy'
    const promoMatch = url.pathname.startsWith(promoRoot + '/') ? [url.pathname, url.pathname.slice(promoRoot.length + 1)] : null
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
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim()
      if (!allowRequest(ip)) return send(res, 429, { success: false, error: 'RATE_LIMITED', retryAfterSeconds: 60 }, origin)
      try {
        if (promoMatch[1] === 'promo' && req.method === 'GET') {
          const terms = await tenergyRequest('/promo')
          if (terms.network !== 'mainnet') return send(res, 502, { success: false, error: 'PROVIDER_NETWORK_MISMATCH' }, origin)
          let redemption = null
          try { redemption = await tenergyRequest('/promo/redemptions/' + encodeURIComponent(walletAddress)) }
          catch (error) { if (error.status !== 404) throw error }
          return send(res, 200, { success: true, provider: 'TEnergy', network: 'mainnet', terms, redemption, claimMethod: 'wallet-message-signature', transactionRequired: false, note: 'One-time promotional Energy only for addresses the provider marked eligible while its Mainnet promotion is active. No paid order or TRX transfer is used.' }, origin)
        }
        if (promoMatch[1] === 'challenge' && req.method === 'POST') {
          const terms = await tenergyRequest('/promo')
          if (terms.network !== 'mainnet' || terms.state !== 'active' || !Number(terms.left_today)) return send(res, 409, { success: false, error: 'FREE_PROMO_NOT_ACTIVE', terms }, origin)
          const challenge = await tenergyRequest('/promo/redeem/challenge', 'POST', { address: walletAddress })
          if (challenge.address !== walletAddress || typeof challenge.nonce !== 'string' || typeof challenge.message !== 'string') return send(res, 502, { success: false, error: 'INVALID_PROVIDER_CHALLENGE' }, origin)
          return send(res, 201, { success: true, provider: 'TEnergy', network: 'mainnet', challenge, approval: 'Sign this exact message in TronLink; this is not a transaction.' }, origin)
        }
        if (promoMatch[1] === 'redeem' && req.method === 'POST') {
          const { nonce, signature } = body
          if (typeof nonce !== 'string' || nonce.length < 8 || nonce.length > 256 || typeof signature !== 'string' || !/^(?:0x)?[0-9a-fA-F]{130}$/.test(signature)) return send(res, 400, { success: false, error: 'INVALID_NONCE_OR_SIGNATURE' }, origin)
          const result = await tenergyRequest('/promo/redeem', 'POST', { address: walletAddress, nonce, signature })
          if (result.address !== walletAddress || !['granting', 'delegated', 'failed'].includes(result.status)) return send(res, 502, { success: false, error: 'INVALID_PROVIDER_REDEMPTION' }, origin)
          return send(res, 201, { success: true, provider: 'TEnergy', network: 'mainnet', redemption: result, verificationPath: promoRoot + '/redemption?address=' + encodeURIComponent(walletAddress) }, origin)
        }
        if (promoMatch[1] === 'redemption' && req.method === 'GET') {
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
    if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' }, origin)
    const match = url.pathname.match(/^\/v1\/resources\/(T[1-9A-HJ-NP-Za-km-z]{33})$/)
    if (!match || !isMainnetAddress(match[1])) return send(res, 400, { error: 'INVALID_TRON_ADDRESS' }, origin)
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim()
    if (!allowRequest(ip)) return send(res, 429, { error: 'RATE_LIMITED', retryAfterSeconds: 60 }, origin)
    const address = match[1]
    const cached = cache.get(address)
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return send(res, 200, cached.value, origin)
    try {
      const value = await readResources(address)
      cache.set(address, { at: Date.now(), value })
      return send(res, 200, { address, network: 'TRON Mainnet', ...value }, origin)
    } catch (error) {
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 503
      const isAuthOrRate = status === 401 || status === 403 || status === 429
      return send(res, status === 429 ? 503 : status, {
        error: isAuthOrRate ? 'PUBLIC_RPC_LIMITED' : 'TRON_RPC_UNAVAILABLE',
        message: isAuthOrRate
          ? 'The public TRON RPC rejected anonymous requests or rate-limited this service. No API key or paid provider is configured; retry later or connect a public node you trust.'
          : 'Could not read current Mainnet resources from the public TRON RPC. No resource amount has been assumed.',
      }, origin)
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 10000)
  createServer().listen(port, '0.0.0.0', () => {
    process.stdout.write('TRON resource API listening on ' + port + '\n')
  })
}
