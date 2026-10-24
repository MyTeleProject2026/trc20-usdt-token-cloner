import { Router } from 'express'

const NETWORKS = Object.freeze({
  mainnet: 'https://api.trongrid.io',
  shasta: 'https://api.shasta.trongrid.io',
  nile: 'https://nile.trongrid.io',
})
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const BASE_UNITS_PATTERN = /^[1-9][0-9]{0,77}$/
const UINT256_MAX = (1n << 256n) - 1n
const OFFICIAL_MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

function integerString(value, optional = false) {
  if (value === undefined && optional) return '0'
  if (typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  return null
}

function allowlistedAsset(env, network, contract) {
  if (network === 'mainnet' && contract === OFFICIAL_MAINNET_USDT) return 'USDT'
  for (const asset of ['USDT', 'VTRC']) {
    const configured = String(env[`SPONSOR_${asset}_${network.toUpperCase()}_CONTRACTS`] || '')
      .split(',').map((item) => item.trim()).filter(Boolean)
    if (configured.includes(contract)) return asset
  }
  return null
}

function asTronHex(tronWeb, address) {
  if (typeof address !== 'string' || !ADDRESS_PATTERN.test(address) || !tronWeb.isAddress(address)) return null
  const value = String(tronWeb.address.toHex(address) || '').replace(/^0x/i, '').toLowerCase()
  return /^41[0-9a-f]{40}$/.test(value) ? value : null
}

function parseResources(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.Error) {
    throw new Error('invalid-resource-response')
  }
  const energyLimit = integerString(payload.EnergyLimit, true)
  const energyUsed = integerString(payload.EnergyUsed, true)
  const netLimit = integerString(payload.NetLimit, true)
  const netUsed = integerString(payload.NetUsed, true)
  const freeNetLimit = integerString(payload.freeNetLimit, true)
  const freeNetUsed = integerString(payload.freeNetUsed, true)
  if ([energyLimit, energyUsed, netLimit, netUsed, freeNetLimit, freeNetUsed].some((v) => v === null)
    || BigInt(energyUsed) > BigInt(energyLimit)
    || BigInt(netUsed) > BigInt(netLimit)
    || BigInt(freeNetUsed) > BigInt(freeNetLimit)) {
    throw new Error('invalid-resource-response')
  }
  return {
    energyLimit,
    energyUsed,
    availableEnergy: (BigInt(energyLimit) - BigInt(energyUsed)).toString(),
    netLimit,
    netUsed,
    availableStakedBandwidth: (BigInt(netLimit) - BigInt(netUsed)).toString(),
    freeNetLimit,
    freeNetUsed,
    availableFreeBandwidth: (BigInt(freeNetLimit) - BigInt(freeNetUsed)).toString(),
  }
}

/**
 * Read-only transaction-specific energy estimation. It does not sign, reserve,
 * delegate resources, submit, or broadcast. The fee sponsor's own resources are
 * reported separately and never counted as available to the principal sponsor
 * until an on-chain delegation has been independently verified.
 */
export function createSponsorFeeEstimateRouter({
  env = process.env,
  fetchImpl = globalThis.fetch,
  tronWebFactory = async (host) => {
    const { TronWeb } = await import('tronweb')
    return new TronWeb({ fullHost: host })
  },
  timeoutMs = 8000,
} = {}) {
  const router = Router()

  router.post('/sponsorship/fee-estimate', async (req, res) => {
    res.setHeader?.('Cache-Control', 'no-store')
    res.setHeader?.('Pragma', 'no-cache')
    res.setHeader?.('Vary', 'Origin')

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    const allowedFields = new Set(['network', 'tokenContract', 'receiverAddress', 'amountBaseUnits'])
    if (Object.keys(body).some((field) => !allowedFields.has(field))) {
      return res.status(400).json({ success: false, status: 'invalid-request', message: 'Only network, tokenContract, receiverAddress and amountBaseUnits are accepted.' })
    }
    const { network, tokenContract, receiverAddress, amountBaseUnits } = body
    if (typeof network !== 'string' || !Object.hasOwn(NETWORKS, network)) {
      return res.status(400).json({ success: false, status: 'invalid-network', message: 'network must be mainnet, shasta, or nile.' })
    }
    if (typeof tokenContract !== 'string' || !ADDRESS_PATTERN.test(tokenContract)
      || typeof receiverAddress !== 'string' || !ADDRESS_PATTERN.test(receiverAddress)) {
      return res.status(400).json({ success: false, status: 'invalid-address', message: 'tokenContract and receiverAddress must be valid TRON Base58 addresses.' })
    }
    if (typeof amountBaseUnits !== 'string' || !BASE_UNITS_PATTERN.test(amountBaseUnits)
      || BigInt(amountBaseUnits) > UINT256_MAX) {
      return res.status(400).json({ success: false, status: 'invalid-amount', message: 'amountBaseUnits must be a positive uint256 integer string.' })
    }
    const asset = allowlistedAsset(env, network, tokenContract)
    if (!asset) {
      return res.status(403).json({
        success: false,
        status: 'token-contract-not-allowlisted',
        network,
        canSubmitSponsoredTransfer: false,
        message: 'This contract is not in the sponsor token allowlist for the selected network. No provider call or transaction was made.',
      })
    }

    const assetSponsorAddress = typeof env[`SPONSOR_ASSET_${network.toUpperCase()}_ADDRESS`] === 'string'
      ? env[`SPONSOR_ASSET_${network.toUpperCase()}_ADDRESS`].trim() : ''
    const feeSponsorAddress = typeof env[`SPONSOR_FEE_${network.toUpperCase()}_ADDRESS`] === 'string'
      ? env[`SPONSOR_FEE_${network.toUpperCase()}_ADDRESS`].trim() : ''
    if (!assetSponsorAddress || !feeSponsorAddress) {
      return res.status(503).json({
        success: false,
        status: 'sponsor-role-addresses-not-configured',
        network,
        requiredEnvironment: [
          `SPONSOR_ASSET_${network.toUpperCase()}_ADDRESS`,
          `SPONSOR_FEE_${network.toUpperCase()}_ADDRESS`,
        ],
        canSubmitSponsoredTransfer: false,
        message: 'Both the principal sponsor and network-fee sponsor must be configured before estimating sponsor resource coverage.',
      })
    }
    if (assetSponsorAddress === feeSponsorAddress) {
      return res.status(409).json({
        success: false,
        status: 'sponsor-role-addresses-not-distinct',
        network,
        canSubmitSponsoredTransfer: false,
        message: 'The fee sponsor and principal sponsor must be distinct for this product policy.',
      })
    }

    try {
      const tronWeb = await tronWebFactory(NETWORKS[network])
      const principalHex = asTronHex(tronWeb, assetSponsorAddress)
      const feeSponsorHex = asTronHex(tronWeb, feeSponsorAddress)
      const contractHex = asTronHex(tronWeb, tokenContract)
      const receiverHex = asTronHex(tronWeb, receiverAddress)
      if (!principalHex || !feeSponsorHex || !contractHex || !receiverHex) {
        return res.status(400).json({ success: false, status: 'invalid-address-checksum', network, canSubmitSponsoredTransfer: false })
      }

      const headers = { accept: 'application/json', 'content-type': 'application/json' }
      if (typeof env.TRONGRID_API_KEY === 'string' && env.TRONGRID_API_KEY.trim()) {
        headers['TRON-PRO-API-KEY'] = env.TRONGRID_API_KEY.trim()
      }
      const post = async (path, payload) => {
        const response = await fetchImpl(NETWORKS[network] + path, {
          method: 'POST',
          redirect: 'error',
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!response.ok) throw new Error('provider-http-error')
        const result = await response.json()
        if (!result || typeof result !== 'object' || Array.isArray(result) || result.Error) {
          throw new Error('invalid-provider-response')
        }
        return result
      }

      // ABI arguments only: 32-byte padded address + exact uint256 base units.
      const receiverArgument = receiverHex.slice(2).padStart(64, '0')
      const amountArgument = BigInt(amountBaseUnits).toString(16).padStart(64, '0')
      const parameter = receiverArgument + amountArgument
      const [simulation, chainParameters, principalResourcesPayload, feeSponsorResourcesPayload] = await Promise.all([
        post('/wallet/triggerconstantcontract', {
          owner_address: principalHex,
          contract_address: contractHex,
          function_selector: 'transfer(address,uint256)',
          parameter,
          visible: false,
        }),
        post('/wallet/getchainparameters', {}),
        post('/wallet/getaccountresource', { address: principalHex, visible: false }),
        post('/wallet/getaccountresource', { address: feeSponsorHex, visible: false }),
      ])
      if (simulation?.result?.result !== true) {
        return res.status(422).json({
          success: false,
          status: 'contract-simulation-failed',
          network,
          asset,
          tokenContract,
          receiverAddress,
          canSubmitSponsoredTransfer: false,
          message: 'The current-node contract simulation did not confirm a successful transfer. Sponsor submission remains disabled.',
          simulationCode: typeof simulation?.result?.code === 'string' ? simulation.result.code : undefined,
        })
      }
      const energyRequired = integerString(simulation.energy_used)
      if (energyRequired === null) {
        return res.status(502).json({ success: false, status: 'invalid-energy-estimate', network, canSubmitSponsoredTransfer: false })
      }
      const params = Array.isArray(chainParameters.chainParameter) ? chainParameters.chainParameter : []
      const energyFeeEntry = params.find((item) => item?.key === 'getEnergyFee')
      const bandwidthFeeEntry = params.find((item) => item?.key === 'getTransactionFee')
      const energyFeeSun = integerString(energyFeeEntry?.value)
      const bandwidthFeeSunPerByte = integerString(bandwidthFeeEntry?.value)
      if (energyFeeSun === null || bandwidthFeeSunPerByte === null) {
        return res.status(502).json({ success: false, status: 'chain-fee-parameters-unavailable', network, canSubmitSponsoredTransfer: false })
      }
      const principalResources = parseResources(principalResourcesPayload)
      const feeSponsorResources = parseResources(feeSponsorResourcesPayload)
      const energyShortfall = BigInt(energyRequired) > BigInt(principalResources.availableEnergy)
        ? (BigInt(energyRequired) - BigInt(principalResources.availableEnergy)).toString()
        : '0'
      const estimatedEnergyBurnSun = (BigInt(energyShortfall) * BigInt(energyFeeSun)).toString()
      const estimatedEnergyBurnTRX = (() => {
        const whole = BigInt(estimatedEnergyBurnSun) / 1_000_000n
        const fraction = (BigInt(estimatedEnergyBurnSun) % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
        return fraction ? whole.toString() + '.' + fraction : whole.toString()
      })()

      return res.json({
        success: true,
        status: 'read-only-energy-estimate-incomplete-total-fee',
        network,
        asset,
        tokenContract,
        receiverAddress,
        amountBaseUnits,
        checkedAt: new Date().toISOString(),
        estimation: {
          method: 'TRON wallet/triggerconstantcontract current-node simulation',
          estimatedEnergyRequired: energyRequired,
          currentEnergyFeeSun: energyFeeSun,
          estimatedEnergyBurnSun,
          estimatedEnergyBurnTRX,
          bandwidthFeeSunPerByte: bandwidthFeeSunPerByte,
          bandwidthCostEstimated: false,
          totalNetworkFeeEstimated: false,
          principalSponsorResources: principalResources,
          feeSponsorResources: feeSponsorResources,
          feeSponsorResourcesCountedTowardPrincipalTransfer: false,
          resourceDelegationVerified: false,
        },
        blockers: [
          ...(BigInt(energyShortfall) > 0n ? ['principal-sponsor-energy-shortfall'] : []),
          'fee-sponsor-resource-delegation-not-verified',
          'exact-signed-transaction-bandwidth-not-estimated',
          'dynamic-energy-and-contract-resource-sharing-may-change-actual-cost',
          'provider-signing-and-broadcast-adapter-disabled',
        ],
        canSubmitSponsoredTransfer: false,
        submissionEnabled: false,
        transactionBroadcast: false,
        unpaidFallbackToUserFunds: false,
        note: 'This is a read-only, current-node energy estimate for the allowlisted contract and exact transfer calldata. The network-fee sponsor’s own resources are not usable by the principal sponsor until a delegation is submitted and independently verified. Bandwidth and total fees are not estimated here; no spend authorization or transfer is created.',
      })
    } catch {
      return res.status(502).json({
        success: false,
        status: 'fee-estimate-unavailable',
        network,
        canSubmitSponsoredTransfer: false,
        message: 'Could not complete the read-only TRON fee estimate. No reservation, signature or transaction was created.',
      })
    }
  })

  return router
}

export default createSponsorFeeEstimateRouter()
