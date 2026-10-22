import { createHmac } from 'node:crypto'

const NETWORKS = Object.freeze({
  mainnet: {
    origin: 'https://open.gasfree.io',
    pathPrefix: '/tron',
    chainLabel: 'TRON Mainnet',
  },
  nile: {
    origin: 'https://open-test.gasfree.io',
    pathPrefix: '/nile',
    chainLabel: 'TRON Nile testnet',
  },
})

const TOKEN_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/

export function getGasFreeNetwork(network) {
  return typeof network === 'string' && Object.hasOwn(NETWORKS, network)
    ? { network, ...NETWORKS[network] }
    : null
}

/**
 * GasFree's documented API auth signs METHOD + request path + Unix timestamp.
 * Only server-side API credentials may be passed here. Never put API_SECRET in
 * Vite/frontend env, response JSON, URLs, request bodies, or logs.
 */
export function buildGasFreeAuthHeaders(method, path, { apiKey, apiSecret, timestamp }) {
  if (typeof apiKey !== 'string' || !apiKey.trim()
    || typeof apiSecret !== 'string' || !apiSecret.trim()
    || !Number.isSafeInteger(timestamp) || timestamp <= 0
    || typeof method !== 'string' || !/^(GET|POST)$/i.test(method)
    || typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    throw new TypeError('Invalid GasFree API authentication input')
  }
  const normalizedMethod = method.toUpperCase()
  const signature = createHmac('sha256', apiSecret)
    .update(`${normalizedMethod}${path}${timestamp}`, 'utf8')
    .digest('base64')
  return {
    Timestamp: String(timestamp),
    Authorization: `ApiKey ${apiKey.trim()}:${signature}`,
    Accept: 'application/json',
  }
}

function validIntegerString(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null
  }
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value) ? value : null
}

function normalizeProviders(payload) {
  if (!Array.isArray(payload?.data?.providers)) return null
  return payload.data.providers
    .filter((item) => item && typeof item.address === 'string'
      && TOKEN_ADDRESS.test(item.address)
      && typeof item.name === 'string' && item.name.trim().length > 0)
    .map((item) => ({
      address: item.address,
      name: item.name.trim().slice(0, 100),
      website: typeof item.website === 'string' && /^https:\/\//i.test(item.website)
        ? item.website.slice(0, 300)
        : null,
      config: {
        maxPendingTransfer: Number.isSafeInteger(item.config?.maxPendingTransfer)
          ? item.config.maxPendingTransfer : null,
        minDeadlineDuration: Number.isSafeInteger(item.config?.minDeadlineDuration)
          ? item.config.minDeadlineDuration : null,
        maxDeadlineDuration: Number.isSafeInteger(item.config?.maxDeadlineDuration)
          ? item.config.maxDeadlineDuration : null,
        defaultDeadlineDuration: Number.isSafeInteger(item.config?.defaultDeadlineDuration)
          ? item.config.defaultDeadlineDuration : null,
      },
    }))
}

function normalizeTokens(payload) {
  if (!Array.isArray(payload?.data?.tokens)) return null
  return payload.data.tokens
    .filter((item) => item && typeof item.tokenAddress === 'string'
      && TOKEN_ADDRESS.test(item.tokenAddress)
      && typeof item.symbol === 'string' && item.symbol.trim().length > 0
      && Number.isInteger(item.decimal) && item.decimal >= 0 && item.decimal <= 255
      && validIntegerString(item.activateFee) !== null
      && validIntegerString(item.transferFee) !== null)
    .map((item) => ({
      tokenAddress: item.tokenAddress,
      symbol: item.symbol.trim().slice(0, 32),
      decimals: item.decimal,
      supported: item.supported === true,
      activationFeeBaseUnits: validIntegerString(item.activateFee),
      transferFeeBaseUnits: validIntegerString(item.transferFee),
      feeCurrency: 'transferred-token',
    }))
}

export function createGasFreeClient({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => Math.floor(Date.now() / 1000),
  timeoutMs = 8000,
} = {}) {
  function credentials() {
    const apiKey = env.GASFREE_API_KEY
    const apiSecret = env.GASFREE_API_SECRET
    return typeof apiKey === 'string' && apiKey.trim()
      && typeof apiSecret === 'string' && apiSecret.trim()
      ? { apiKey: apiKey.trim(), apiSecret }
      : null
  }

  async function getJson(networkConfig, endpointPath, auth) {
    const path = `${networkConfig.pathPrefix}${endpointPath}`
    const headers = buildGasFreeAuthHeaders('GET', path, auth)
    const response = await fetchImpl(`${networkConfig.origin}${path}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      const error = new Error('GasFree API request failed')
      error.providerStatus = response.status
      throw error
    }
    const payload = await response.json()
    if (!payload || (payload.code !== 200 && payload.code !== '200')) {
      const error = new Error('GasFree returned an invalid API response')
      error.providerStatus = response.status
      throw error
    }
    return payload
  }

  return {
    isConfigured: () => Boolean(credentials()),
    async getCapabilities(network) {
      const config = getGasFreeNetwork(network)
      if (!config) return { configured: this.isConfigured(), reachable: false, reason: 'unsupported-network' }
      const auth = credentials()
      if (!auth) {
        return {
          configured: false,
          reachable: false,
          network,
          networkLabel: config.chainLabel,
          reason: 'credentials-not-configured',
          requiredEnvironment: ['GASFREE_API_KEY', 'GASFREE_API_SECRET'],
        }
      }
      if (typeof fetchImpl !== 'function') {
        return { configured: true, reachable: false, network, reason: 'fetch-unavailable' }
      }

      try {
        const [providerPayload, tokenPayload] = await Promise.all([
          getJson(config, '/api/v1/config/provider/all', { ...auth, timestamp: now() }),
          getJson(config, '/api/v1/config/token/all', { ...auth, timestamp: now() }),
        ])
        const providers = normalizeProviders(providerPayload)
        const tokens = normalizeTokens(tokenPayload)
        if (!providers || !tokens) {
          return { configured: true, reachable: false, network, reason: 'invalid-provider-response' }
        }
        return {
          configured: true,
          reachable: true,
          network,
          networkLabel: config.chainLabel,
          providerCount: providers.length,
          supportedTokenCount: tokens.filter((token) => token.supported).length,
          providers,
          tokens,
          providerFundingVerified: false,
          canSubmitSponsoredTransfer: false,
          feePolicy: 'GasFree token activation and transfer fees are charged in the transferred token; these are not confirmed to be free.',
          note: 'Discovery only. Provider listing and API reachability do not prove sponsor funding, zero fees, transaction authorization, or exchange deposit credit.',
        }
      } catch (error) {
        const status = Number.isInteger(error?.providerStatus) ? error.providerStatus : null
        return {
          configured: true,
          reachable: false,
          network,
          networkLabel: config.chainLabel,
          reason: status === 401 || status === 403 ? 'provider-auth-rejected'
            : status ? 'provider-http-error' : 'provider-unreachable',
          ...(status ? { providerStatus: status } : {}),
        }
      }
    },
  }
}
