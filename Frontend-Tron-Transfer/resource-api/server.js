import http from 'node:http'

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

export function isMainnetAddress(value) {
  return typeof value === 'string' && /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value)
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

export function createServer() {
  return http.createServer(async (req, res) => {
    const origin = req.headers.origin
    if (origin && !ALLOWED_ORIGINS.has(origin)) return send(res, 403, { error: 'ORIGIN_NOT_ALLOWED' })
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': origin || 'null',
        'access-control-allow-methods': 'GET, OPTIONS',
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

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  const port = Number(process.env.PORT || 10000)
  createServer().listen(port, '0.0.0.0', () => {
    process.stdout.write('TRON resource API listening on ' + port + '\n')
  })
}
