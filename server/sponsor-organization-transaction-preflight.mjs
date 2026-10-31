import { tatumProviderFetch } from './tatum-provider-fetch.mjs'
import { readSponsorDelegationSnapshot } from './sponsor-delegation-snapshot.mjs'
import { isValidTronAddress } from './tron-address.mjs'

const HOSTS = Object.freeze({
  mainnet: 'https://api.trongrid.io',
  nile: 'https://nile.trongrid.io',
  shasta: 'https://api.shasta.trongrid.io',
})
const POSITIVE_INTEGER = /^[1-9][0-9]{0,77}$/
const OFFICIAL_MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

function integerString(value, optional = false) {
  if (value === undefined && optional) return '0'
  if (typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  return null
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
  if ([energyLimit, energyUsed, netLimit, netUsed, freeNetLimit, freeNetUsed].some((value) => value === null)
    || BigInt(energyUsed) > BigInt(energyLimit)
    || BigInt(netUsed) > BigInt(netLimit)
    || BigInt(freeNetUsed) > BigInt(freeNetLimit)) {
    throw new Error('invalid-resource-response')
  }
  return {
    availableEnergy: (BigInt(energyLimit) - BigInt(energyUsed)).toString(),
    availableStakedBandwidth: (BigInt(netLimit) - BigInt(netUsed)).toString(),
    availableFreeBandwidth: (BigInt(freeNetLimit) - BigInt(freeNetUsed)).toString(),
  }
}

function protobufVarintLength(value) {
  let remaining = BigInt(value)
  let length = 1
  while (remaining >= 128n) {
    remaining >>= 7n
    length += 1
  }
  return length
}

function signedTransactionByteEstimate(rawDataHex) {
  const unsignedBytes = rawDataHex.length / 2
  // A single 65-byte TRON signature plus protobuf field/tag/length overhead.
  return {
    unsignedBytes,
    estimatedSignedBytes: unsignedBytes
      + 1 + protobufVarintLength(unsignedBytes)
      + 1 + protobufVarintLength(65) + 65,
  }
}

function toHexAddress(tronWeb, address) {
  if (!isValidTronAddress(address) || !tronWeb.isAddress(address)) return null
  const hex = String(tronWeb.address.toHex(address) || '').replace(/^0x/i, '').toLowerCase()
  return /^41[0-9a-f]{40}$/.test(hex) ? hex : null
}

function formatTrx(sun) {
  const value = BigInt(sun)
  const whole = value / 1_000_000n
  const fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return fraction ? whole.toString() + '.' + fraction : whole.toString()
}

function isActiveDelegation(value, feeAddress, principalAddress) {
  return value?.success === true
    && value.status === 'solidified-delegation-state-read'
    && value.fromAddress === feeAddress
    && value.toAddress === principalAddress
    && (BigInt(value.activeEnergyStakeSun || '0') > 0n
      || BigInt(value.activeBandwidthStakeSun || '0') > 0n)
}

/**
 * Read-only preflight for one already reserved and dual-owner-approved intent.
 * It creates an unsigned draft and reads live node resources; it never signs,
 * delegates, reserves, submits, broadcasts, or changes the intent state.
 */
export async function preflightSponsorOrganizationPayoutIntent({
  store,
  intentId,
  env = process.env,
  fetchImpl = tatumProviderFetch,
  tronWebFactory = async (host) => {
    const { TronWeb } = await import('tronweb')
    return new TronWeb({ fullHost: host })
  },
  readDelegation = readSponsorDelegationSnapshot,
  timeoutMs = 8000,
} = {}) {
  const fail = (reason, extra = {}) => ({
    success: false,
    status: reason,
    reason,
    canSubmitSponsoredTransfer: false,
    submissionEnabled: false,
    transactionSubmitted: false,
    userFundedFallbackAllowed: false,
    ...extra,
  })
  if (!store || typeof store.getPayoutIntentForPreflight !== 'function'
    || typeof intentId !== 'string' || !/^[1-9][0-9]{0,17}$/.test(intentId)) {
    return fail('invalid-payout-intent-preflight-request')
  }

  let loaded
  try {
    loaded = await store.getPayoutIntentForPreflight(intentId)
  } catch {
    return fail('payout-intent-read-unavailable')
  }
  if (!loaded?.success || !loaded.intent) return fail(loaded?.reason || 'payout-intent-not-preflightable')
  const intent = loaded.intent
  if (intent.id !== intentId || intent.status !== 'sponsor_authorization_complete'
    || loaded.sponsorOwnerApprovalsVerified !== true
    || !['mainnet', 'nile', 'shasta'].includes(intent.network)
    || !['TRX', 'USDT'].includes(intent.asset)
    || !isValidTronAddress(intent.receiverAddress)
    || !isValidTronAddress(intent.principalSponsorAddress)
    || !isValidTronAddress(intent.feeSponsorAddress)
    || intent.principalSponsorAddress === intent.feeSponsorAddress
    || !POSITIVE_INTEGER.test(intent.amountBaseUnits || '')
    || !POSITIVE_INTEGER.test(intent.feeCapSun || '')
    || new Date(intent.expiresAt).getTime() <= Date.now()) {
    return fail('payout-intent-scope-or-expiry-invalid')
  }
  if (intent.asset === 'TRX' && intent.tokenContract !== null
    || intent.asset === 'USDT' && !isValidTronAddress(intent.tokenContract)) {
    return fail('payout-intent-token-scope-invalid')
  }
  if (intent.network === 'mainnet' && intent.asset === 'USDT'
    && intent.tokenContract !== OFFICIAL_MAINNET_USDT) {
    return fail('official-mainnet-usdt-contract-required')
  }

  const feeCap = BigInt(intent.feeCapSun)
  if (feeCap > BigInt(Number.MAX_SAFE_INTEGER)) return fail('fee-cap-exceeds-safe-provider-range')
  if (intent.asset === 'TRX' && BigInt(intent.amountBaseUnits) > BigInt(Number.MAX_SAFE_INTEGER)) {
    return fail('native-trx-amount-exceeds-safe-provider-range')
  }

  try {
    const tronWeb = await tronWebFactory(HOSTS[intent.network])
    const principalHex = toHexAddress(tronWeb, intent.principalSponsorAddress)
    const feeHex = toHexAddress(tronWeb, intent.feeSponsorAddress)
    const receiverHex = toHexAddress(tronWeb, intent.receiverAddress)
    const contractHex = intent.asset === 'USDT' ? toHexAddress(tronWeb, intent.tokenContract) : null
    if (!principalHex || !feeHex || !receiverHex || (intent.asset === 'USDT' && !contractHex)) {
      return fail('payout-intent-address-checksum-invalid')
    }

    const headers = { accept: 'application/json', 'content-type': 'application/json' }
    if (typeof env.TRONGRID_API_KEY === 'string' && env.TRONGRID_API_KEY.trim()) {
      headers['TRON-PRO-API-KEY'] = env.TRONGRID_API_KEY.trim()
    }
    const post = async (path, payload) => {
      const response = await fetchImpl(HOSTS[intent.network] + path, {
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

    let energyRequired = '0'
    let transaction
    if (intent.asset === 'TRX') {
      transaction = await post('/wallet/createtransaction', {
        owner_address: principalHex,
        to_address: receiverHex,
        amount: Number(intent.amountBaseUnits),
        visible: false,
      })
      const contract = transaction?.raw_data?.contract?.length === 1
        ? transaction.raw_data.contract[0] : null
      const value = contract?.parameter?.value
      if (contract?.type !== 'TransferContract'
        || String(value?.owner_address || '').replace(/^0x/i, '').toLowerCase() !== principalHex
        || String(value?.to_address || '').replace(/^0x/i, '').toLowerCase() !== receiverHex
        || integerString(value?.amount) !== intent.amountBaseUnits) {
        return fail('unsigned-transaction-validation-failed')
      }
    } else {
      const receiverArgument = receiverHex.slice(2).padStart(64, '0')
      const amountArgument = BigInt(intent.amountBaseUnits).toString(16).padStart(64, '0')
      const parameter = receiverArgument + amountArgument
      const [simulation, built] = await Promise.all([
        post('/wallet/triggerconstantcontract', {
          owner_address: principalHex,
          contract_address: contractHex,
          function_selector: 'transfer(address,uint256)',
          parameter,
          visible: false,
        }),
        post('/wallet/triggersmartcontract', {
          owner_address: principalHex,
          contract_address: contractHex,
          function_selector: 'transfer(address,uint256)',
          parameter,
          fee_limit: Number(feeCap),
          call_value: 0,
          visible: false,
        }),
      ])
      if (simulation?.result?.result !== true) return fail('contract-simulation-failed')
      energyRequired = integerString(simulation.energy_used)
      if (energyRequired === null || BigInt(energyRequired) <= 0n) return fail('invalid-energy-estimate')
      transaction = built?.transaction
      const contract = transaction?.raw_data?.contract?.length === 1
        ? transaction.raw_data.contract[0] : null
      const value = contract?.parameter?.value
      const expectedData = 'a9059cbb' + receiverArgument + amountArgument
      if (built?.result?.result !== true || contract?.type !== 'TriggerSmartContract'
        || String(value?.owner_address || '').replace(/^0x/i, '').toLowerCase() !== principalHex
        || String(value?.contract_address || '').replace(/^0x/i, '').toLowerCase() !== contractHex
        || String(value?.data || '').replace(/^0x/i, '').toLowerCase() !== expectedData
        || (value?.fee_limit !== undefined && integerString(value.fee_limit) !== intent.feeCapSun)) {
        return fail('unsigned-transaction-validation-failed')
      }
    }

    const rawDataHex = transaction?.raw_data_hex
    if (typeof rawDataHex !== 'string' || rawDataHex.length < 2 || rawDataHex.length > 65_536
      || !/^(?:[0-9a-fA-F]{2})+$/.test(rawDataHex)) {
      return fail('unsigned-transaction-raw-data-invalid')
    }
    const byteEstimate = signedTransactionByteEstimate(rawDataHex)
    const [chainParameters, principalResourcesPayload, feeResourcesPayload] = await Promise.all([
      post('/wallet/getchainparameters', {}),
      post('/wallet/getaccountresource', { address: principalHex, visible: false }),
      post('/wallet/getaccountresource', { address: feeHex, visible: false }),
    ])
    const parameters = Array.isArray(chainParameters.chainParameter) ? chainParameters.chainParameter : []
    const energyFeeSun = integerString(parameters.find((item) => item?.key === 'getEnergyFee')?.value)
    const bandwidthFeeSunPerByte = integerString(parameters.find((item) => item?.key === 'getTransactionFee')?.value)
    if (bandwidthFeeSunPerByte === null || (intent.asset === 'USDT' && energyFeeSun === null)) {
      return fail('chain-fee-parameters-unavailable')
    }
    const principalResources = parseResources(principalResourcesPayload)
    const feeSponsorResources = parseResources(feeResourcesPayload)
    const delegation = await readDelegation({
      env, fetchImpl, timeoutMs, network: intent.network, tronWeb,
      feeSponsorAddress: intent.feeSponsorAddress,
      principalSponsorAddress: intent.principalSponsorAddress,
    })
    const delegationObserved = isActiveDelegation(delegation, intent.feeSponsorAddress, intent.principalSponsorAddress)

    const availableEnergy = BigInt(principalResources.availableEnergy)
    const availableBandwidth = BigInt(principalResources.availableStakedBandwidth)
      + BigInt(principalResources.availableFreeBandwidth)
    const energyShortfall = BigInt(energyRequired) > availableEnergy
      ? BigInt(energyRequired) - availableEnergy : 0n
    const bandwidthShortfall = BigInt(byteEstimate.estimatedSignedBytes) > availableBandwidth
      ? BigInt(byteEstimate.estimatedSignedBytes) - availableBandwidth : 0n
    const energyBurnSun = intent.asset === 'USDT' ? energyShortfall * BigInt(energyFeeSun) : 0n
    const bandwidthBurnSun = bandwidthShortfall * BigInt(bandwidthFeeSunPerByte)
    const estimatedNetworkFeeSun = energyBurnSun + bandwidthBurnSun
    const feeCapCovered = estimatedNetworkFeeSun <= feeCap
    const resourcesCovered = energyShortfall === 0n && bandwidthShortfall === 0n
    const blockers = [
      ...(!resourcesCovered ? ['principal-sponsor-resources-insufficient-for-current-estimate'] : []),
      ...(!delegationObserved ? ['current-fee-to-principal-delegation-not-observed'] : []),
      ...(!feeCapCovered ? ['estimated-network-fee-exceeds-intent-fee-cap'] : []),
      'final-signed-transaction-size-and-finalized-node-quote-may-differ',
      'current-resource-snapshot-can-change-before-broadcast',
      'no-sponsor-controlled-transaction-signer-or-broadcast-adapter',
    ]
    return {
      success: true,
      status: resourcesCovered && delegationObserved && feeCapCovered
        ? 'transaction-specific-resource-preflight-passed-review-required'
        : 'transaction-specific-resource-preflight-blocked',
      intent: {
        id: intent.id, intentDigest: intent.intentDigest, network: intent.network,
        asset: intent.asset, tokenContract: intent.tokenContract,
        receiverAddress: intent.receiverAddress, amountBaseUnits: intent.amountBaseUnits,
        feeCapSun: intent.feeCapSun, expiresAt: intent.expiresAt,
      },
      sponsorOwnerApprovalsVerified: true,
      transactionDraft: {
        builtAndValidated: true,
        signed: false,
        broadcast: false,
        estimatedUnsignedRawDataBytes: byteEstimate.unsignedBytes,
        estimatedSignedTransactionBytes: byteEstimate.estimatedSignedBytes,
        finalSignedTransactionSizeExact: false,
      },
      resourceEstimate: {
        estimatedEnergyRequired: energyRequired,
        principalAvailableEnergy: principalResources.availableEnergy,
        estimatedEnergyShortfall: energyShortfall.toString(),
        estimatedEnergyBurnSun: energyBurnSun.toString(),
        principalAvailableBandwidth: availableBandwidth.toString(),
        estimatedBandwidthShortfallBytes: bandwidthShortfall.toString(),
        bandwidthFeeSunPerByte,
        estimatedBandwidthBurnSun: bandwidthBurnSun.toString(),
        estimatedNetworkFeeSun: estimatedNetworkFeeSun.toString(),
        estimatedNetworkFeeTRX: formatTrx(estimatedNetworkFeeSun),
        feeCapSun: intent.feeCapSun,
        estimatedFeeWithinIntentCap: feeCapCovered,
        principalResourcesCoverCurrentEstimate: resourcesCovered,
        feeSponsorDelegationObserved: delegationObserved,
        feeSponsorDelegatedEnergyStakeSun: delegation?.activeEnergyStakeSun || '0',
        feeSponsorDelegatedBandwidthStakeSun: delegation?.activeBandwidthStakeSun || '0',
        feeSponsorOwnAvailableEnergy: feeSponsorResources.availableEnergy,
        feeSponsorOwnAvailableBandwidth: (
          BigInt(feeSponsorResources.availableStakedBandwidth)
          + BigInt(feeSponsorResources.availableFreeBandwidth)
        ).toString(),
        feeSponsorOwnResourcesCountedForPrincipal: false,
        energyFeeSunPerEnergy: energyFeeSun,
      },
      blockers,
      transactionSpecificFeeCoverageVerified: false,
      canSubmitSponsoredTransfer: false,
      submissionEnabled: false,
      transactionSubmitted: false,
      userFundedFallbackAllowed: false,
      note: 'This read-only preflight builds and validates an unsigned transaction for this exact approved intent. Resource and fee figures are current-node estimates; delegated resources already appear in the principal account resource snapshot and the fee sponsor\'s separate wallet resources are never added. Final signature size, dynamic execution costs and later chain state can differ. No funds, resources or transaction are moved.',
    }
  } catch {
    return fail('transaction-specific-resource-preflight-unavailable')
  }
}

export default preflightSponsorOrganizationPayoutIntent
