const BASE_URL = 'https://api.tenergy.me/v1'
const ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const UINT = /^(0|[1-9][0-9]{0,17})$/

function amount(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  if (typeof value === 'string' && UINT.test(value)) return value
  return null
}

/**
 * Public TEnergy chain observer. The documented endpoints are read-only:
 * this adapter can inspect resources and service health, but cannot request
 * grants, buy rentals, sign, or broadcast a delegation.
 */
export function createTenergyPublicChainReader({
  fetchImpl = globalThis.fetch,
  timeoutMs = 7000,
} = {}) {
  async function get(path) {
    const response = await fetchImpl(BASE_URL + path, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response?.ok) {
      const error = new Error('tenergy-public-api-unavailable')
      error.status = Number.isInteger(response?.status) ? response.status : undefined
      throw error
    }
    const body = await response.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('tenergy-invalid-response')
    }
    return body
  }

  async function readResources(address) {
    if (typeof address !== 'string' || !ADDRESS.test(address)) {
      return { success: false, provider: 'tenergy', status: 'invalid-address' }
    }
    try {
      const body = await get('/resources/' + encodeURIComponent(address))
      const energyAvailable = amount(body.energy?.available)
      const bandwidthAvailable = amount(body.bandwidth?.available)
      const energyDelegatedIn = amount(body.energy?.delegated_in)
      const bandwidthDelegatedIn = amount(body.bandwidth?.delegated_in)
      if (body.address !== address || typeof body.activated !== 'boolean'
        || energyAvailable === null || bandwidthAvailable === null
        || energyDelegatedIn === null || bandwidthDelegatedIn === null
        || typeof body.as_of !== 'string' || !Number.isFinite(Date.parse(body.as_of))) {
        throw new Error('tenergy-resource-schema-invalid')
      }
      return {
        success: true,
        provider: 'tenergy',
        network: 'mainnet',
        status: 'public-resource-observation',
        address,
        activated: body.activated,
        asOf: body.as_of,
        resources: {
          energyAvailable,
          energyDelegatedIn: energyDelegatedIn,
          bandwidthAvailableForOneTransaction: bandwidthAvailable,
          bandwidthDelegatedIn,
        },
        capabilities: {
          publicResourceRead: true,
          publicServiceHealth: true,
          amountSpecificGrantEligibility: false,
          freeGrantRequest: false,
          providerManagedSigner: false,
          bandwidthGrant: false,
        },
        limitation: 'The documented public endpoints are read-only. They do not authorize or submit Energy/Bandwidth grants.',
      }
    } catch (error) {
      return {
        success: false,
        provider: 'tenergy',
        network: 'mainnet',
        status: 'public-resource-observation-unavailable',
        httpStatus: Number.isInteger(error?.status) ? error.status : undefined,
        capabilities: {
          publicResourceRead: true,
          amountSpecificGrantEligibility: false,
          freeGrantRequest: false,
          providerManagedSigner: false,
          bandwidthGrant: false,
        },
      }
    }
  }

  async function health() {
    try {
      const body = await get('/status')
      return {
        success: true,
        provider: 'tenergy',
        reachable: body.network === 'mainnet' && ['operational', 'degraded'].includes(body.status),
        network: body.network,
        status: body.status,
        asOf: typeof body.as_of === 'string' ? body.as_of : null,
        capabilities: { publicServiceHealth: true, grantSubmission: false },
      }
    } catch (error) {
      return {
        success: false,
        provider: 'tenergy',
        reachable: false,
        status: 'public-status-unavailable',
        httpStatus: Number.isInteger(error?.status) ? error.status : undefined,
        capabilities: { publicServiceHealth: true, grantSubmission: false },
      }
    }
  }

  return Object.freeze({ readResources, health })
}
