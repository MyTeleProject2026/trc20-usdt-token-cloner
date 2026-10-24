import { createHmac } from 'node:crypto'

const NETWORKS = Object.freeze({
  mainnet: {
    origin: 'https://open.gasfree.io',
    pathPrefix: '/tron',
    chainLabel: 'TRON Mainnet',
    apiKeyEnv: 'GASFREE_MAINNET_API_KEY',
    apiSecretEnv: 'GASFREE_MAINNET_API_SECRET',
  },
  nile: {
    origin: 'https://open-test.gasfree.io',
    pathPrefix: '/nile',
    chainLabel: 'TRON Nile testnet',
    apiKeyEnv: 'GASFREE_NILE_API_KEY',
    apiSecretEnv: 'GASFREE_NILE_API_SECRET',
  },
})

const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const TRACE_ID = /^[A-Za-z0-9_-]{1,128}$/

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
      && TRON_ADDRESS.test(item.address)
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
      && TRON_ADDRESS.test(item.tokenAddress)
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

function normalizeAccount(payload, requestedAddress) {
  const account = payload?.data
  if (!account || typeof account !== 'object'
    || account.accountAddress !== requestedAddress
    || typeof account.gasFreeAddress !== 'string'
    || !TRON_ADDRESS.test(account.gasFreeAddress)
    || typeof account.active !== 'boolean'
    || !Number.isSafeInteger(account.nonce) || account.nonce < 0
    || typeof account.allowSubmit !== 'boolean'
    || !Array.isArray(account.assets)) return null

  const assets = account.assets
    .filter((item) => item && typeof item.tokenAddress === 'string'
      && TRON_ADDRESS.test(item.tokenAddress)
      && typeof item.tokenSymbol === 'string'
      && Number.isInteger(item.decimal) && item.decimal >= 0 && item.decimal <= 255)
    .map((item) => ({
      tokenAddress: item.tokenAddress,
      tokenSymbol: item.tokenSymbol.trim().slice(0, 32),
      decimals: item.decimal,
      activationFeeBaseUnits: validIntegerString(item.activateFee),
      transferFeeBaseUnits: validIntegerString(item.transferFee),
      frozenBaseUnits: validIntegerString(item.frozen),
      // The documented account response does not guarantee a spendable-balance
      // field. Only expose it if the live provider supplied a valid value.
      ...(validIntegerString(item.balance) !== null
        ? { providerReportedBalanceBaseUnits: validIntegerString(item.balance) }
        : {}),
    }))

  return {
    accountAddress: account.accountAddress,
    gasFreeAddress: account.gasFreeAddress,
    active: account.active,
    nonce: account.nonce,
    allowSubmit: account.allowSubmit,
    assets,
    source: 'GasFree provider account API',
    chainFinalityVerified: false,
    note: 'Provider account metadata is not independent solidified-chain proof. A missing balance field is unknown, not zero; verify balances and receipts on-chain before any accounting.',
  }
}

function normalizeTrace(payload, requestedTraceId) {
  const data = payload?.data
  if (!data || typeof data !== 'object') return null
  // The official API identifies the authorization by its traceId in `data.id`.
  // Do not substitute the caller's requested ID when the provider omits it:
  // that would turn an uncorrelated response into a falsely "verified" lookup.
  if (typeof data.id !== 'string' || data.id !== requestedTraceId) return null
  const returnedId = data.id
  const state = typeof data.state === 'string' ? data.state
    : typeof data.status === 'string' ? data.status : null
  const txCandidate = [data.txnHash, data.transactionId, data.transactionHash, data.txHash, data.txID]
    .find((value) => typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value))
  const amount = validIntegerString(data.amount)
  const maxFee = validIntegerString(data.maxFee)
  const normalizeAddress = (value) => typeof value === 'string' && TRON_ADDRESS.test(value) ? value : null
  return {
    traceId: returnedId.slice(0, 128),
    state: state ? state.toUpperCase().slice(0, 32) : 'UNKNOWN',
    senderAddress: normalizeAddress(data.accountAddress),
    gasFreeAddress: normalizeAddress(data.gasFreeAddress),
    receiverAddress: normalizeAddress(data.targetAddress || data.receiver),
    providerAddress: normalizeAddress(data.providerAddress),
    tokenAddress: normalizeAddress(data.tokenAddress || data.token),
    ...(amount !== null ? { amountBaseUnits: amount } : {}),
    ...(maxFee !== null ? { maxFeeBaseUnits: maxFee } : {}),
    transactionId: txCandidate || null,
    createdAt: typeof data.createdAt === 'string' ? data.createdAt.slice(0, 64) : null,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt.slice(0, 64) : null,
    expiredAt: typeof data.expiredAt === 'string' ? data.expiredAt.slice(0, 64) : null,
    source: 'GasFree provider trace API',
    verifiedOnChain: false,
    note: 'A provider trace state is not independent proof of finalized receipt, exact token Transfer event, receiver balance, or exchange deposit credit.',
  }
}

export function createGasFreeClient({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => Math.floor(Date.now() / 1000),
  timeoutMs = 8000,
} = {}) {
  function credentials(config) {
    const apiKey = env[config.apiKeyEnv]
    const apiSecret = env[config.apiSecretEnv]
    return typeof apiKey === 'string' && apiKey.trim()
      && typeof apiSecret === 'string' && apiSecret.trim()
      ? { apiKey: apiKey.trim(), apiSecret }
      : null
  }

  async function getJson(networkConfig, endpointPath, auth) {
    // endpointPath is selected internally, never built from arbitrary URL input.
    const path = `${networkConfig.pathPrefix}${endpointPath}`
    const headers = buildGasFreeAuthHeaders('GET', path, auth)
    const response = await fetchImpl(`${networkConfig.origin}${path}`, {
      method: 'GET',
      headers,
      // Never forward signed provider credentials through an HTTP redirect.
      redirect: 'error',
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
      error.reasonCode = 'invalid-provider-response'
      throw error
    }
    return payload
  }

  async function withReadOnlyAccess(network, operation) {
    const config = getGasFreeNetwork(network)
    if (!config) return { configured: false, reachable: false, network, reason: 'unsupported-network' }
    const auth = credentials(config)
    if (!auth) {
      return {
        configured: false,
        reachable: false,
        network,
        networkLabel: config.chainLabel,
        reason: 'credentials-not-configured',
        requiredEnvironment: [config.apiKeyEnv, config.apiSecretEnv],
      }
    }
    if (typeof fetchImpl !== 'function') {
      return { configured: true, reachable: false, network, reason: 'fetch-unavailable' }
    }
    try {
      const data = await operation(config, auth)
      return { configured: true, reachable: true, network, networkLabel: config.chainLabel, ...data }
    } catch (error) {
      const status = Number.isInteger(error?.providerStatus) ? error.providerStatus : null
      return {
        configured: true,
        reachable: false,
        network,
        networkLabel: config.chainLabel,
        reason: error?.reasonCode || (status === 401 || status === 403 ? 'provider-auth-rejected'
          : status ? 'provider-http-error' : 'provider-unreachable'),
        ...(status ? { providerStatus: status } : {}),
      }
    }
  }

  return {
    isConfigured(network) {
      const config = getGasFreeNetwork(network)
      return Boolean(config && credentials(config))
    },
    async getCapabilities(network) {
      return withReadOnlyAccess(network, async (config, auth) => {
        const [providerPayload, tokenPayload] = await Promise.all([
          getJson(config, '/api/v1/config/provider/all', { ...auth, timestamp: now() }),
          getJson(config, '/api/v1/config/token/all', { ...auth, timestamp: now() }),
        ])
        const providers = normalizeProviders(providerPayload)
        const tokens = normalizeTokens(tokenPayload)
        if (!providers || !tokens) throw Object.assign(new Error('Invalid provider response'), { providerStatus: 502, reasonCode: 'invalid-provider-response' })
        return {
          providerCount: providers.length,
          supportedTokenCount: tokens.filter((token) => token.supported).length,
          providers,
          tokens,
          providerFundingVerified: false,
          canSubmitSponsoredTransfer: false,
          feePolicy: 'GasFree token activation and transfer fees are charged in the transferred token; these are not confirmed to be free.',
          note: 'Discovery only. Provider listing and API reachability do not prove sponsor funding, zero fees, transaction authorization, or exchange deposit credit.',
        }
      })
    },
    async getAccount(network, accountAddress) {
      if (typeof accountAddress !== 'string' || !TRON_ADDRESS.test(accountAddress)) {
        return { configured: false, reachable: false, network, reason: 'invalid-account-address' }
      }
      return withReadOnlyAccess(network, async (config, auth) => {
        const payload = await getJson(
          config,
          `/api/v1/address/${encodeURIComponent(accountAddress)}`,
          { ...auth, timestamp: now() },
        )
        const account = normalizeAccount(payload, accountAddress)
        if (!account) throw Object.assign(new Error('Invalid account response'), { providerStatus: 502, reasonCode: 'invalid-provider-response' })
        return { account, accountLookupVerified: true }
      })
    },
    async getTrace(network, traceId) {
      if (typeof traceId !== 'string' || !TRACE_ID.test(traceId)) {
        return { configured: false, reachable: false, network, reason: 'invalid-trace-id' }
      }
      return withReadOnlyAccess(network, async (config, auth) => {
        const payload = await getJson(
          config,
          `/api/v1/gasfree/${encodeURIComponent(traceId)}`,
          { ...auth, timestamp: now() },
        )
        const trace = normalizeTrace(payload, traceId)
        if (!trace) throw Object.assign(new Error('Invalid trace response'), { providerStatus: 502, reasonCode: 'invalid-provider-response' })
        return { trace, traceLookupVerified: true }
      })
    },
  }
}
