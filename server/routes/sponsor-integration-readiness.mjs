import { Router } from 'express'
import { createGasFreeClient } from '../gasfree-client.mjs'
import { getSponsorIntegrationReadiness } from '../sponsor-integration-readiness.mjs'

export { getSponsorIntegrationReadiness } from '../sponsor-integration-readiness.mjs'

const PROVIDER_NETWORKS = ['mainnet', 'nile']
const PROVIDER_PROBE_CACHE_TTL_MS = 15_000

function safeReason(value) {
  return typeof value === 'string' && /^[a-z0-9-]{1,64}$/.test(value)
    ? value
    : 'provider-discovery-unavailable'
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

async function checkProviderDiscovery(network, networkReadiness, client) {
  if (!networkReadiness.credentialsConfigured) {
    return {
      discoveryReachabilityVerified: false,
      discoveryStatus: 'credentials-missing',
      providerCount: null,
      supportedTokenCount: null,
    }
  }
  if (typeof client?.getCapabilities !== 'function') {
    return {
      discoveryReachabilityVerified: false,
      discoveryStatus: 'check-unavailable',
      providerCount: null,
      supportedTokenCount: null,
    }
  }

  try {
    const result = await client.getCapabilities(network)
    if (result?.configured === true && result?.reachable === true) {
      return {
        discoveryReachabilityVerified: true,
        discoveryStatus: 'reachable',
        providerCount: safeCount(result.providerCount),
        supportedTokenCount: safeCount(result.supportedTokenCount),
      }
    }
    return {
      discoveryReachabilityVerified: false,
      discoveryStatus: safeReason(result?.reason),
      providerCount: null,
      supportedTokenCount: null,
      ...(Number.isInteger(result?.providerStatus) && result.providerStatus >= 100 && result.providerStatus <= 599
        ? { providerStatus: result.providerStatus } : {}),
    }
  } catch {
    // Never serialize thrown provider errors; messages may contain credentials or URLs.
    return {
      discoveryReachabilityVerified: false,
      discoveryStatus: 'provider-discovery-unavailable',
      providerCount: null,
      supportedTokenCount: null,
    }
  }
}

/**
 * Returns non-cacheable configuration diagnostics plus a read-only provider
 * discovery probe on networks with configured credentials. This is not sponsor
 * funding proof, signing authority, or transfer authorization.
 */
export function createSponsorIntegrationReadinessRouter(options = {}) {
  const router = Router()
  const env = options.env ?? process.env
  const client = options.gasFreeClient ?? createGasFreeClient({ env })
  let providerProbeCache = null
  let providerProbeCacheExpiresAt = 0
  let providerProbeInFlight = null

  async function getProviderChecks(baseNetworks) {
    if (providerProbeCache && providerProbeCacheExpiresAt > Date.now()) {
      return providerProbeCache
    }
    if (providerProbeInFlight) return providerProbeInFlight

    const probe = Promise.all(PROVIDER_NETWORKS.map(async (network) => {
      const checked = await checkProviderDiscovery(network, baseNetworks[network].gasFree, client)
      return [network, { ...baseNetworks[network], gasFree: {
        ...baseNetworks[network].gasFree,
        ...checked,
        discoveryCheckedAt: new Date().toISOString(),
        submitSignBroadcastAdapterIntegrated: false,
        providesAssetPrincipal: false,
        noUserCostPolicySatisfied: false,
      } }]
    })).then((entries) => {
      providerProbeCache = Object.fromEntries(entries)
      providerProbeCacheExpiresAt = Date.now() + PROVIDER_PROBE_CACHE_TTL_MS
      return providerProbeCache
    })

    providerProbeInFlight = probe
    try {
      return await probe
    } finally {
      if (providerProbeInFlight === probe) providerProbeInFlight = null
    }
  }

  router.get('/sponsorship/integration-readiness', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')

    const base = getSponsorIntegrationReadiness({ ...options, env, gasFreeClient: client })
    const providerNetworks = await getProviderChecks(base.networks)
    const networks = {
      ...base.networks,
      ...providerNetworks,
      shasta: {
        ...base.networks.shasta,
        gasFree: {
          ...base.networks.shasta.gasFree,
          discoveryReachabilityVerified: false,
          discoveryStatus: 'unsupported-network',
          providerCount: null,
          supportedTokenCount: null,
        },
      },
    }

    return res.status(200).json({
      ...base,
      checkedAt: new Date().toISOString(),
      networks,
      limitations: [
        'This endpoint performs only read-only GasFree provider discovery for mainnet and Nile when credentials are configured; the Shasta network is not documented by this integration.',
        'Provider discovery reachability is not sponsor funding proof, spend authority, zero-fee eligibility, transaction authorization, signing, broadcast, or exchange deposit credit.',
        'Sponsor addresses and allowlists report configuration and format only. They do not verify live account ownership or spendable chain balances.',
        'Sponsored submission remains disabled and user-funded fallback is prohibited until a separately approved signer/provider adapter, explicit sponsor mandate, funded budgets, tested settlement and operator approval exist.',
      ],
    })
  })
  return router
}

export default createSponsorIntegrationReadinessRouter()
