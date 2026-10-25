import { createSponsorFundingReader } from './sponsor-funding.mjs'
import { createSponsorResourceReader } from './sponsor-resources.mjs'
import { readSponsorDelegationSnapshot } from './sponsor-delegation-snapshot.mjs'
import { isValidTronAddress } from './tron-address.mjs'

const NETWORKS = new Set(['mainnet', 'shasta', 'nile'])

function makeRoleEnvironment(source, role) {
  return new Proxy(source, {
    get(target, property) {
      if (typeof property === 'string') {
        const match = property.match(/^SPONSOR_(MAINNET|SHASTA|NILE)_ADDRESS$/)
        if (match) return target[`SPONSOR_${role}_${match[1]}_ADDRESS`]
      }
      return target[property]
    },
  })
}

function cleanNative(funding) {
  if (funding?.native?.status !== 'verified') return { status: 'not-verified' }
  return {
    status: 'verified',
    asset: 'TRX',
    balanceSun: funding.native.balanceSun,
    balanceTRX: funding.native.balanceTRX,
    accountExists: funding.native.accountExists === true,
  }
}

function cleanTokens(funding) {
  if (!Array.isArray(funding?.tokens)) return []
  return funding.tokens.map((token) => ({
    asset: token.asset,
    tokenContract: token.tokenContract,
    status: token.status,
    ...(token.status === 'verified' && typeof token.balanceBaseUnits === 'string'
      ? { balanceBaseUnits: token.balanceBaseUnits, decimals: token.decimals }
      : {}),
  }))
}

function buildRoleSnapshot(role, network, configuredAddress, funding, resources = null) {
  const addressConfigured = typeof configuredAddress === 'string' && configuredAddress.trim().length > 0
  const requiredEnvironment = funding?.status === 'sponsor-address-not-configured'
    ? [`SPONSOR_${role}_${network.toUpperCase()}_ADDRESS`]
    : (Array.isArray(funding?.requiredEnvironment) ? funding.requiredEnvironment : [])
  const resourceRead = resources?.success === true && resources?.resourceRead === true
  return {
    role: role === 'FEE' ? 'network-fee-sponsor' : 'asset-principal-sponsor',
    network,
    status: funding?.status || 'sponsor-status-unavailable',
    addressConfigured,
    address: isValidTronAddress(typeof configuredAddress === 'string' ? configuredAddress.trim() : '')
      ? configuredAddress.trim() : null,
    onChainBalanceRead: funding?.onChainBalanceRead === true,
    native: cleanNative(funding),
    tokens: cleanTokens(funding),
    tokenBalancesComplete: funding?.tokenBalancesComplete === true,
    resourceStatus: role === 'FEE'
      ? {
          status: resources?.status || 'resource-read-unavailable',
          resourceRead,
          currentlyAvailableEnergy: resourceRead ? resources.resources?.currentlyAvailableEnergy : undefined,
          currentlyAvailableBandwidth: resourceRead ? resources.resources?.currentlyAvailableBandwidth : undefined,
          maxDelegatableEnergyStakeSun: resourceRead ? resources.resources?.maxDelegatableEnergyStakeSun : undefined,
          maxDelegatableBandwidthStakeSun: resourceRead ? resources.resources?.maxDelegatableBandwidthStakeSun : undefined,
        }
      : null,
    sponsorFundingVerified: funding?.sponsorFundingVerified === true,
    sponsorAgreementVerified: funding?.sponsorAgreementVerified === true,
    canSubmitSponsoredTransfer: false,
    submissionEnabled: false,
    requiredEnvironment,
  }
}

/**
 * Read-only separation of the network-fee sponsor and asset-principal sponsor.
 * These snapshots report public chain state, not sponsor consent, a spendable
 * program budget, transfer authorization, or permission to broadcast.
 */
export function createSponsorRoleFundingReader({
  env = process.env,
  fetchImpl = globalThis.fetch,
  tronWebFactory,
  timeoutMs = 8000,
} = {}) {
  const feeEnv = makeRoleEnvironment(env, 'FEE')
  const assetEnv = makeRoleEnvironment(env, 'ASSET')
  const readFeeFunding = createSponsorFundingReader({ env: feeEnv, fetchImpl, tronWebFactory })
  const readAssetFunding = createSponsorFundingReader({ env: assetEnv, fetchImpl, tronWebFactory })
  const readFeeResources = createSponsorResourceReader({ env: feeEnv, fetchImpl, tronWebFactory, timeoutMs })

  return async function readSponsorRoleFunding(network, { refresh = false } = {}) {
    if (typeof network !== 'string' || !NETWORKS.has(network)) {
      return { success: false, status: 'invalid-network', network: network ?? null, roles: {} }
    }
    const networkKey = network.toUpperCase()
    const feeAddress = typeof env[`SPONSOR_FEE_${networkKey}_ADDRESS`] === 'string'
      ? env[`SPONSOR_FEE_${networkKey}_ADDRESS`].trim() : ''
    const assetAddress = typeof env[`SPONSOR_ASSET_${networkKey}_ADDRESS`] === 'string'
      ? env[`SPONSOR_ASSET_${networkKey}_ADDRESS`].trim() : ''

    const [feeFunding, assetFunding, feeResources, feeSponsorDelegationToPrincipal] = await Promise.all([
      readFeeFunding(network, { refresh }),
      readAssetFunding(network, { refresh }),
      readFeeResources(network, { refresh }),
      readSponsorDelegationSnapshot({
        env,
        fetchImpl,
        tronWebFactory,
        timeoutMs,
        network,
        feeSponsorAddress: feeAddress,
        principalSponsorAddress: assetAddress,
      }),
    ])
    const configuredAddressesDistinct = Boolean(feeAddress && assetAddress && feeAddress !== assetAddress)
    const networkFeeSponsor = buildRoleSnapshot('FEE', network, feeAddress, feeFunding, feeResources)
    const assetPrincipalSponsor = buildRoleSnapshot('ASSET', network, assetAddress, assetFunding)

    return {
      success: true,
      status: 'read-only-sponsor-roles',
      network,
      checkedAt: new Date().toISOString(),
      accountsConfigured: Boolean(feeAddress && assetAddress),
      configuredAddressesDistinct,
      roles: {
        networkFeeSponsor,
        assetPrincipalSponsor,
      },
      feeSponsorDelegationToPrincipal,
      // Internal consumer inputs for exact-address budget reconciliation.
      // HTTP handlers must omit this implementation field from public status.
      fundingSnapshots: {
        networkFeeSponsor: feeFunding,
        assetPrincipalSponsor: assetFunding,
      },
      canSubmitSponsoredTransfer: false,
      submissionEnabled: false,
      limitations: [
        'Sponsor fee-payer and asset-principal accounts are configured and read independently; address configuration does not verify the real-world identity or consent of either sponsor.',
        'On-chain balances and resource snapshots are not approval to spend, do not establish a funded off-chain budget, and are not receiver credits.',
        'The fee sponsor resource snapshot does not prove a future transfer will be fee-free. Delegation, transfer authorization, and transaction-specific reconciliation remain separate.',
        'This endpoint is read-only. No wallet is signed, no resource is delegated, no token principal is sent, and no user-funded fallback is permitted.',
      ],
    }
  }
}
