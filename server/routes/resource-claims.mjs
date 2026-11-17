import { Router } from 'express'
import { createFreeDelegationResourceReader } from '../free-delegation-resources.mjs'
import { createResourceClaimOrchestrator } from '../resource-claim-orchestrator.mjs'

const OWNER_ADDRESS = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'

/**
 * Read-only owner diagnostics for automatic Mainnet resource claims.
 * Grant submission is intentionally not exposed until a real, authorized
 * provider adapter has been reviewed and installed.
 */
export function createResourceClaimsRouter(options = {}) {
  const router = Router()
  const allowedAddress = options.allowedAddress ?? OWNER_ADDRESS
  const readStatus = options.readStatus ?? createFreeDelegationResourceReader(options)
  const orchestrator = options.orchestrator ?? createResourceClaimOrchestrator({
    adapters: options.adapters ?? [],
    network: 'mainnet',
  })

  router.get('/resources/claims/readiness', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    res.setHeader('Pragma', 'no-cache')
    const address = typeof req.query?.address === 'string' ? req.query.address : ''
    if (address !== allowedAddress) {
      return res.status(403).json({
        success: false,
        error: 'wallet-not-allowed',
        message: 'Automatic resource-claim diagnostics are restricted to the configured TRON Mainnet owner wallet.',
      })
    }

    const [resourceSnapshot, providerReadiness] = await Promise.all([
      readStatus(address, { refresh: req.query?.refresh === '1' }),
      orchestrator.getReadiness(address),
    ])
    const resources = resourceSnapshot?.success === true
      ? resourceSnapshot.resources
      : null
    return res.status(200).json({
      success: true,
      network: 'mainnet',
      ownerAddress: address,
      checkedAt: new Date().toISOString(),
      status: resources ? 'resource-snapshot-and-provider-readiness-checked' : 'provider-readiness-checked-resource-snapshot-unavailable',
      providerReadiness,
      resourceSnapshot,
      automaticClaim: {
        enabled: false,
        requestEndpointEnabled: false,
        reason: providerReadiness?.providerReachable === true
          ? 'provider-eligibility-must-be-checked-for-exact-resource-amounts'
          : 'no-authorized-provider-adapter',
      },
      deployment: {
        ready: false,
        mayBroadcast: false,
        reason: 'exact-deployment-simulation-and-zero-trx-burn-preflight-not-run',
      },
      limitations: [
        'This endpoint performs read-only provider and Mainnet resource checks; it does not request, sign, or broadcast a resource delegation.',
        'A grant can be automated only through an official provider adapter using that provider account’s pre-authorized server-side signer.',
        'A resource snapshot is not a deployment simulation and does not prove full deployment Energy or Bandwidth coverage.',
      ],
    })
  })

  return router
}

export default createResourceClaimsRouter()
