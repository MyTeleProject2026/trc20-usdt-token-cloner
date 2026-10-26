import { tatumProviderFetch } from './tatum-provider-fetch.mjs'
const NETWORKS = Object.freeze({
  mainnet: { host: 'https://tron-mainnet.gateway.tatum.io', addressEnv: 'SPONSOR_MAINNET_ADDRESS' },
  shasta: { host: 'https://tron-shasta.gateway.tatum.io', addressEnv: 'SPONSOR_SHASTA_ADDRESS' },
  nile: { host: 'https://tron-nile.gateway.tatum.io', addressEnv: 'SPONSOR_NILE_ADDRESS' },
})
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const BASE_UNITS_PATTERN = /^(0|[1-9][0-9]{0,77})$/

function integerString(value) {
  if (typeof value === 'string' && BASE_UNITS_PATTERN.test(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  return null
}

// Provider node errors often arrive as HTTP 200 JSON with an Error field.
// Return only a fixed diagnostic category; never echo the provider's message.
function classifyProviderError(payload) {
  const text = [payload?.Error, payload?.error, payload?.message, payload?.code]
    .filter((value) => typeof value === 'string')
    .join(' ')
    .toLowerCase()
  if (!text) return 'invalid-response-shape'
  if (/(account|address).{0,80}(not found|does not exist|doesn't exist|unknown)|no account/.test(text)) {
    return 'account-not-found'
  }
  if (/invalid.{0,40}address|address.{0,40}invalid/.test(text)) return 'invalid-address'
  if (/method.{0,50}(not found|unsupported)|endpoint.{0,50}(not found|unsupported)|not supported/.test(text)) {
    return 'endpoint-not-supported'
  }
  if (/rate.?limit|too many requests|quota exceeded/.test(text)) return 'rate-limited'
  if (/parameter|argument|invalid request|missing.{0,40}(address|type)/.test(text)) return 'invalid-request'
  return 'node-error-response'
}

function classifyTransportError(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'provider-timeout'
  if (error?.name === 'TypeError') return 'provider-transport-error'
  return 'provider-request-failed'
}

/**
 * Reads the configured sponsor's current TRON resource snapshot and current
 * Stake-2.0 delegation ceilings. This never signs, delegates, reserves, or
 * sends funds. The wallet owner must approve each actual delegation separately.
 */
export function createSponsorResourceReader({
  env = process.env,
  fetchImpl = tatumProviderFetch,
  tronWebFactory = async (host) => {
    const { TronWeb } = await import('tronweb')
    return new TronWeb({ fullHost: host })
  },
  timeoutMs = 8000,
} = {}) {
  const cache = new Map()
  const inFlight = new Map()
  const cacheTtlMs = 5000
  const failedTtlMs = 1500

  async function readFresh(network) {
    const config = typeof network === 'string' && Object.hasOwn(NETWORKS, network)
      ? NETWORKS[network] : null
    if (!config) return { success: false, network: network ?? null, status: 'invalid-network' }

    const sponsorAddress = typeof env[config.addressEnv] === 'string' ? env[config.addressEnv].trim() : ''
    if (!sponsorAddress) {
      return {
        success: false, network, status: 'sponsor-address-not-configured',
        requiredEnvironment: [config.addressEnv], resourceRead: false,
        delegationEnabled: false,
      }
    }
    if (!ADDRESS_PATTERN.test(sponsorAddress)) {
      return { success: false, network, status: 'invalid-sponsor-address', requiredEnvironment: [config.addressEnv], resourceRead: false, delegationEnabled: false }
    }
    if (typeof env.TATUM_API_KEY !== 'string' || !env.TATUM_API_KEY.trim()) {
      return { success: false, network, status: 'provider-credentials-missing', sponsorAddress, requiredEnvironment: ['TATUM_API_KEY'], resourceRead: false, delegationEnabled: false }
    }
    if (typeof fetchImpl !== 'function') {
      return { success: false, network, status: 'provider-unavailable', sponsorAddress, resourceRead: false, delegationEnabled: false }
    }

    try {
      const tronWeb = await tronWebFactory(config.host)
      if (typeof tronWeb?.isAddress !== 'function' || !tronWeb.isAddress(sponsorAddress)) {
        return { success: false, network, status: 'invalid-sponsor-address', sponsorAddress, resourceRead: false, delegationEnabled: false }
      }
      const headers = { 'content-type': 'application/json', 'x-api-key': env.TATUM_API_KEY.trim() }
      const post = async (stage, path, body) => {
        let response
        try {
          response = await fetchImpl(config.host + path, {
            method: 'POST',
            redirect: 'error',
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
          })
        } catch (cause) {
          const error = new Error('provider-request-failed')
          error.failureStage = stage
          error.providerResponseCategory = classifyTransportError(cause)
          throw error
        }

        if (!response?.ok) {
          const error = new Error('provider-http-error')
          if (Number.isInteger(response?.status)) error.status = response.status
          error.failureStage = stage
          error.providerResponseCategory = 'provider-http-error'
          throw error
        }

        let payload
        try {
          payload = await response.json()
        } catch {
          const error = new Error('provider-invalid-json')
          error.failureStage = stage
          error.providerResponseCategory = 'invalid-json-response'
          throw error
        }

        if (!payload || typeof payload !== 'object' || Array.isArray(payload)
          || payload.Error || payload.error || payload.result === false) {
          const error = new Error('provider-node-error')
          error.failureStage = stage
          error.providerResponseCategory = classifyProviderError(payload)
          throw error
        }
        return payload
      }
      const [resources, energyDelegation, bandwidthDelegation] = await Promise.all([
        // Use Base58Check addresses with visible:true, matching Tatum's
        // documented request examples for these TRON FullNode endpoints.
        post('account-resource', '/wallet/getaccountresource', { address: sponsorAddress, visible: true }),
        post('energy-delegation-ceiling', '/wallet/getcandelegatedmaxsize', { owner_address: sponsorAddress, type: 1, visible: true }),
        post('bandwidth-delegation-ceiling', '/wallet/getcandelegatedmaxsize', { owner_address: sponsorAddress, type: 0, visible: true }),
      ])
      const energyLimit = integerString(resources.EnergyLimit)
      const energyUsed = integerString(resources.EnergyUsed ?? 0)
      const netLimit = integerString(resources.NetLimit ?? 0)
      const netUsed = integerString(resources.NetUsed ?? 0)
      const freeNetLimit = integerString(resources.freeNetLimit ?? 0)
      const freeNetUsed = integerString(resources.freeNetUsed ?? 0)
      const maxEnergyStakeSun = integerString(energyDelegation.max_size)
      const maxBandwidthStakeSun = integerString(bandwidthDelegation.max_size)
      if ([energyLimit, energyUsed, netLimit, netUsed, freeNetLimit, freeNetUsed].some((v) => v === null)
        || BigInt(energyUsed) > BigInt(energyLimit)
        || BigInt(netUsed) > BigInt(netLimit)
        || BigInt(freeNetUsed) > BigInt(freeNetLimit)) {
        const error = new Error('invalid-resource-response')
        error.failureStage = 'account-resource'
        error.providerResponseCategory = 'invalid-response-shape'
        throw error
      }
      if (maxEnergyStakeSun === null || maxBandwidthStakeSun === null) {
        const error = new Error('invalid-delegation-ceiling-response')
        error.failureStage = maxEnergyStakeSun === null
          ? 'energy-delegation-ceiling'
          : 'bandwidth-delegation-ceiling'
        error.providerResponseCategory = 'invalid-response-shape'
        throw error
      }
      return {
        success: true,
        status: 'sponsor-resource-snapshot-read',
        network,
        sponsorAddress,
        checkedAt: new Date().toISOString(),
        source: 'Tatum TRON FullNode account-resource and Stake-2.0 delegation queries',
        resourceRead: true,
        resources: {
          energyLimit, energyUsed, currentlyAvailableEnergy: (BigInt(energyLimit) - BigInt(energyUsed)).toString(),
          netLimit, netUsed, currentlyAvailableBandwidth: (BigInt(netLimit) - BigInt(netUsed)).toString(),
          freeNetLimit, freeNetUsed, currentlyAvailableFreeBandwidth: (BigInt(freeNetLimit) - BigInt(freeNetUsed)).toString(),
          maxDelegatableEnergyStakeSun: maxEnergyStakeSun,
          maxDelegatableBandwidthStakeSun: maxBandwidthStakeSun,
        },
        delegationEnabled: false,
        canSubmitSponsoredTransfer: false,
        note: 'Latest resource snapshot only. Delegatable stake is reported in SUN-equivalent staked TRX, not Energy units. It does not prove a transfer will be fully covered; the sponsor must sign and verify a delegation, and each transfer must independently check resource coverage.',
      }
    } catch (error) {
      return {
        success: false,
        network,
        status: 'resource-read-unavailable',
        ...(Number.isInteger(error?.status) ? { providerStatus: error.status } : {}),
        ...(typeof error?.failureStage === 'string' ? { failureStage: error.failureStage } : {}),
        ...(typeof error?.providerResponseCategory === 'string'
          ? { providerResponseCategory: error.providerResponseCategory } : {}),
        sponsorAddress,
        resourceRead: false,
        delegationEnabled: false,
      }
    }
  }

  return async function readSponsorResourceStatus(network, { refresh = false } = {}) {
    if (typeof network !== 'string' || !Object.hasOwn(NETWORKS, network)) {
      return { success: false, network: network ?? null, status: 'invalid-network', resourceRead: false, delegationEnabled: false }
    }
    const cached = cache.get(network)
    if (!refresh && cached && cached.expiresAt > Date.now()) return { ...cached.result, cache: { status: 'cached', ageMs: Date.now() - cached.checkedAt } }
    if (inFlight.has(network)) return inFlight.get(network)
    const promise = readFresh(network).then((result) => {
      const ttl = result.success ? cacheTtlMs : failedTtlMs
      cache.set(network, { result, checkedAt: Date.now(), expiresAt: Date.now() + ttl })
      if (cache.size > 6) cache.delete(cache.keys().next().value)
      return { ...result, cache: { status: result.success ? 'fresh' : 'failed' } }
    }).finally(() => inFlight.delete(network))
    inFlight.set(network, promise)
    return promise
  }
}
