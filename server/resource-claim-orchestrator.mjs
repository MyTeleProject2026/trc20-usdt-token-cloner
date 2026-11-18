const RESOURCE_TYPES = Object.freeze(['ENERGY', 'BANDWIDTH'])
const UINT = /^(0|[1-9][0-9]{0,77})$/
const ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
import { createTronMainnetDelegationVerifier } from './providers/tron-mainnet-delegation-verifier.mjs'

/**
 * Coordinates resource grants through explicitly installed, trusted provider
 * adapters. It never discovers arbitrary URLs, holds provider secrets, or signs
 * transactions itself. A provider adapter must use its own pre-authorized
 * server-side signer and independently verify the resulting Mainnet delegation.
 */
export function createResourceClaimOrchestrator({ adapters = [], network = 'mainnet', delegationVerifier = createTronMainnetDelegationVerifier() } = {}) {
  if (network !== 'mainnet') throw new Error('resource-claims-mainnet-only')
  const providers = adapters.filter((adapter) => adapter && typeof adapter.id === 'string'
    && /^[a-z0-9][a-z0-9-]{1,47}$/.test(adapter.id))

  function adapterReady(adapter) {
    return adapter.network === 'mainnet'
      && adapter.authorizationMode === 'provider-managed-signer'
      && typeof adapter.health === 'function'
      && typeof adapter.checkEligibility === 'function'
      && typeof adapter.requestGrant === 'function'
  }

  async function getReadiness(ownerAddress) {
    if (typeof ownerAddress !== 'string' || !ADDRESS.test(ownerAddress)) {
      return { success: false, network, status: 'invalid-owner-address', providers: [], canRequestGrant: false }
    }
    const rows = await Promise.all(providers.map(async (adapter) => {
      if (!adapterReady(adapter)) return {
        id: adapter.id, configured: false, reachable: false, eligible: false,
        automaticProviderSigning: false, status: 'provider-adapter-incomplete',
      }
      try {
        const health = await adapter.health()
        return {
          id: adapter.id,
          configured: true,
          reachable: health?.reachable === true,
          eligible: false,
          automaticProviderSigning: true,
          status: health?.reachable === true ? 'provider-reachable-eligibility-not-checked' : 'provider-unreachable',
        }
      } catch {
        return {
          id: adapter.id, configured: true, reachable: false, eligible: false,
          automaticProviderSigning: true, status: 'provider-unreachable',
        }
      }
    }))
    const reachable = rows.some((row) => row.configured && row.reachable && row.automaticProviderSigning)
    return {
      success: true,
      network,
      ownerAddress,
      checkedAt: new Date().toISOString(),
      providers: rows,
      // Health is not grant eligibility. Required resource amounts and the
      // provider's zero-cost policy must be checked for each concrete request.
      canRequestGrant: false,
      providerReachable: reachable,
      status: reachable ? 'provider-reachable-eligibility-not-checked' : 'no-authorized-provider-adapter',
      blockers: [
        ...(reachable ? [] : ['no-verified-mainnet-provider-adapter']),
        'resource-amount-specific-eligibility-not-checked',
        'zero-cost-provider-policy-not-confirmed',
        'provider-side-signer-authorization-required',
      ],
      note: 'Provider health alone never authorizes a grant. Eligibility and zero user cost must be checked for the exact requested amounts, then the solidified Mainnet delegation must be independently verified. This service cannot authorize or spend another account’s stake.',
    }
  }

  async function requestGrant({ ownerAddress, requestId, required }) {
    if (typeof ownerAddress !== 'string' || !ADDRESS.test(ownerAddress)
      || typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,96}$/.test(requestId)
      || !required || RESOURCE_TYPES.some((type) => typeof required[type] !== 'string' || !UINT.test(required[type]) || required[type] === '0')) {
      return { success: false, network, status: 'invalid-grant-request' }
    }
    for (const adapter of providers) {
      if (!adapterReady(adapter)) continue
      let eligible = false
      try {
        const health = await adapter.health()
        if (health?.reachable !== true) continue
        const eligibility = await adapter.checkEligibility({ ownerAddress, required, network })
        eligible = eligibility?.eligible === true
          && eligibility?.network === 'mainnet'
          && eligibility?.userCostSun === '0'
      } catch {
        // No grant has been submitted yet; safely try another configured adapter.
        continue
      }
      if (!eligible) continue

      // From this point onward, do not fall through to another provider after
      // an ambiguous submission. A timeout can happen after the provider has
      // already broadcast; retrying another provider could double-delegate.
      let grant
      try {
        grant = await adapter.requestGrant({ ownerAddress, requestId, required, network })
      } catch {
        return {
          success: false, network, provider: adapter.id,
          status: 'grant-submission-outcome-unknown',
          retrySafe: false,
          blockers: ['provider-request-may-have-been-submitted', 'reconcile-provider-request-before-retrying'],
        }
      }
      if (grant?.accepted !== true) continue

      const transactionIds = grant?.transactionIds && typeof grant.transactionIds === 'object'
        ? grant.transactionIds
        : { ENERGY: grant?.transactionId, BANDWIDTH: grant?.transactionId }
      if (grant?.userCostSun !== '0' || RESOURCE_TYPES.some((type) =>
        typeof transactionIds[type] !== 'string' || !/^[0-9a-f]{64}$/i.test(transactionIds[type]))
        || transactionIds.ENERGY === transactionIds.BANDWIDTH) {
        return {
          success: false, network, provider: adapter.id,
          status: 'grant-accepted-response-incomplete-or-not-zero-cost',
          retrySafe: false,
          transactionIds,
        }
      }

      // Energy and Bandwidth providers commonly delegate in separate Stake
      // 2.0 transactions. Verify each exact resource transaction separately.
      let verifications
      try {
        verifications = await Promise.all(RESOURCE_TYPES.map((type) =>
          delegationVerifier.verifyDelegation({
            ownerAddress,
            transactionId: transactionIds[type],
            required: {
              ENERGY: type === 'ENERGY' ? required.ENERGY : '0',
              BANDWIDTH: type === 'BANDWIDTH' ? required.BANDWIDTH : '0',
            },
            network,
          })))
      } catch {
        return {
          success: false, network, provider: adapter.id,
          status: 'grant-submitted-verification-unavailable',
          retrySafe: false,
          transactionIds,
        }
      }
      const valid = verifications.every((verification, index) => {
        const type = RESOURCE_TYPES[index]
        return verification?.verified === true
          && verification.solidified === true
          && verification.network === 'mainnet'
          && verification.ownerAddress === ownerAddress
          && verification.transactionId === transactionIds[type]
          && typeof verification[type] === 'string'
          && UINT.test(verification[type])
          && BigInt(verification[type]) >= BigInt(required[type])
      })
      if (!valid) {
        return {
          success: false, network, provider: adapter.id,
          status: 'grant-not-independently-verified',
          retrySafe: false,
          transactionIds,
        }
      }
      const verifiedResources = {
        ENERGY: verifications[0].ENERGY,
        BANDWIDTH: verifications[1].BANDWIDTH,
      }
      return {
        success: true, network, provider: adapter.id,
        status: 'mainnet-resource-grant-verified',
        ownerAddress,
        transactionIds,
        verifiedResources,
        userCostSun: '0',
        verifiedAt: new Date().toISOString(),
      }
    }
    return {
      success: false, network, status: 'no-eligible-zero-cost-provider-grant',
      blockers: ['provider-unavailable-or-ineligible', 'provider-side-authorization-missing-or-rejected'],
    }
  }

  return Object.freeze({ getReadiness, requestGrant })
}

/**
 * Fail-closed deployment gate. Bandwidth must be fully covered; partial coverage
 * is not treated as zero-cost. Values are decimal base-unit strings.
 */
export function evaluateZeroBurnDeploymentGate({
  energyRequired, energyAvailable, bandwidthRequired, bandwidthAvailable, trxBurnFallbackSun,
} = {}) {
  const values = [energyRequired, energyAvailable, bandwidthRequired, bandwidthAvailable, trxBurnFallbackSun]
  if (values.some((value) => typeof value !== 'string' || !UINT.test(value))) {
    return { ready: false, status: 'invalid-resource-preflight' }
  }
  const energyCovered = BigInt(energyAvailable) >= BigInt(energyRequired)
  const bandwidthCovered = BigInt(bandwidthAvailable) >= BigInt(bandwidthRequired)
  const zeroBurn = trxBurnFallbackSun === '0'
  return {
    ready: energyCovered && bandwidthCovered && zeroBurn,
    status: energyCovered && bandwidthCovered && zeroBurn
      ? 'zero-trx-burn-deployment-ready'
      : 'deployment-blocked-insufficient-resources-or-trx-fallback',
    energyCovered,
    bandwidthCovered,
    zeroBurn,
    deploymentMayProceed: energyCovered && bandwidthCovered && zeroBurn,
  }
}
