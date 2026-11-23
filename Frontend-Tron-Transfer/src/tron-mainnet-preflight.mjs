// Shared TRON Mainnet resource, permission, Energy and zero-TRX budget checks.
// This module is deliberately browser- and artifact-independent so the same
// safety rules are used by the frontend preflight and backend Owner signer.
function addressesEqual(tronWeb, a, b) {
  try { return tronWeb.address.toHex(String(a)).toLowerCase() === tronWeb.address.toHex(String(b)).toLowerCase() }
  catch { return false }
}

function resourceInteger(source, key) {
  const raw = source?.[key] ?? 0
  let value
  try { value = BigInt(raw) } catch { throw new Error('TRON returned an invalid resource field: ' + key) }
  if (value < 0n) throw new Error('TRON returned a negative resource field: ' + key)
  return value
}

export function normalizeMainnetAccountResources(accountResources, chainParameters) {
  if (!accountResources || typeof accountResources !== 'object' || accountResources.Error) {
    throw new Error('TRON Mainnet could not return account resource limits.')
  }
  const parameters = Array.isArray(chainParameters?.chainParameter)
    ? chainParameters.chainParameter
    : Array.isArray(chainParameters) ? chainParameters : []
  const parameter = (key) => {
    const item = parameters.find((entry) => entry?.key === key)
    if (item?.value === undefined || item?.value === null) return null
    try { return BigInt(item.value) } catch { throw new Error('TRON returned an invalid chain parameter: ' + key) }
  }
  const energyLimit = resourceInteger(accountResources, 'EnergyLimit')
  const energyUsed = resourceInteger(accountResources, 'EnergyUsed')
  const freeNetLimit = resourceInteger(accountResources, 'freeNetLimit')
  const freeNetUsed = resourceInteger(accountResources, 'freeNetUsed')
  const netLimit = resourceInteger(accountResources, 'NetLimit')
  const netUsed = resourceInteger(accountResources, 'NetUsed')
  const energyFee = parameter('getEnergyFee')
  const bandwidthFee = parameter('getTransactionFee')
  const maxFeeLimit = parameter('getMaxFeeLimit')
  if (energyFee === null || energyFee <= 0n) throw new Error('TRON Mainnet did not return a valid current Energy fee.')
  return {
    energyLimit: energyLimit.toString(),
    energyUsed: energyUsed.toString(),
    energyAvailable: (energyLimit > energyUsed ? energyLimit - energyUsed : 0n).toString(),
    freeBandwidthLimit: freeNetLimit.toString(),
    freeBandwidthUsed: freeNetUsed.toString(),
    freeBandwidthAvailable: (freeNetLimit > freeNetUsed ? freeNetLimit - freeNetUsed : 0n).toString(),
    stakedBandwidthLimit: netLimit.toString(),
    stakedBandwidthUsed: netUsed.toString(),
    stakedBandwidthAvailable: (netLimit > netUsed ? netLimit - netUsed : 0n).toString(),
    energyFeeSun: energyFee.toString(),
    bandwidthFeeSun: bandwidthFee === null ? null : bandwidthFee.toString(),
    maxFeeLimitSun: maxFeeLimit === null ? null : maxFeeLimit.toString(),
  }
}

export function normalizeMainnetPermissionSnapshot(account, signerAddress, tronWeb) {
  if (!account || typeof account !== 'object' || account.Error) {
    throw new Error('TRON Mainnet could not return this account permission configuration.')
  }
  const owner = account.owner_permission
  if (!owner || !Array.isArray(owner.keys) || owner.keys.length === 0) {
    throw new Error('This account does not expose a readable owner permission and signer-key list.')
  }
  let threshold
  try { threshold = BigInt(owner.threshold) } catch { throw new Error('TRON returned an invalid owner permission threshold.') }
  if (threshold <= 0n) throw new Error('TRON returned a non-positive owner permission threshold.')
  let signerWeight = 0n
  for (const key of owner.keys) {
    if (!key?.address) throw new Error('TRON returned a malformed owner permission key.')
    let weight
    try { weight = BigInt(key.weight) } catch { throw new Error('TRON returned an invalid owner permission key weight.') }
    if (weight <= 0n) throw new Error('TRON returned a non-positive owner permission key weight.')
    if (addressesEqual(tronWeb, key.address, signerAddress)) signerWeight += weight
  }
  const activePermissions = Array.isArray(account.active_permission)
    ? account.active_permission.map((permission) => ({
      id: Number(permission.id),
      name: String(permission.permission_name || permission.name || 'Active permission'),
      threshold: String(permission.threshold ?? ''),
      keyCount: Array.isArray(permission.keys) ? permission.keys.length : 0,
    }))
    : []
  const requiredAdditionalWeight = threshold > signerWeight ? threshold - signerWeight : 0n
  return {
    permissionId: Number.isInteger(Number(owner.id)) ? Number(owner.id) : 0,
    permissionName: String(owner.permission_name || owner.name || 'owner'),
    threshold: threshold.toString(),
    connectedSignerWeight: signerWeight.toString(),
    requiredAdditionalWeight: requiredAdditionalWeight.toString(),
    connectedSignerCanAuthorizeAlone: signerWeight >= threshold,
    ownerKeyCount: owner.keys.length,
    otherOwnerKeyCount: owner.keys.filter((key) => !addressesEqual(tronWeb, key.address, signerAddress)).length,
    activePermissions,
  }
}

function decodeNodeErrorText(value) {
  const raw = String(value ?? '')
  const match = raw.trim().match(/(?:^|:\s*)(?:0x)?((?:[0-9a-f]{2}){8,})$/i)
  if (match) {
    try {
      const decoded = new TextDecoder().decode(Uint8Array.from(match[1].match(/.{2}/g), pair => parseInt(pair, 16))).replace(/\0+$/g, '').trim()
      if (/[a-z]{3}/i.test(decoded)) return decoded
    } catch {}
  }
  return raw
}

export function normalizeDeploymentEnergyEstimate(response) {
  if (!response || response.Error || response.result?.result !== true) {
    const detail = decodeNodeErrorText(response?.result?.message || response?.result?.code || response?.Error || 'Mainnet node could not estimate contract creation Energy')
    throw new Error('TRON Mainnet deployment Energy estimation failed: ' + detail)
  }
  // wallet/estimateenergy reports energy_required; triggerconstantcontract
  // reports energy_used. Validate execution status when the node includes it,
  // but do not require an optional transaction envelope.
  const execution = response.transaction?.ret?.[0]
  const executionRet = String(execution?.ret || '').toUpperCase()
  const contractRet = String(execution?.contractRet || '').toUpperCase()
  const successValues = ['SUCESS', 'SUCCESS']
  if ((executionRet && !successValues.includes(executionRet))
    || (contractRet && !successValues.includes(contractRet))) {
    throw new Error('TRON Mainnet deployment simulation did not execute successfully: '
      + (contractRet || executionRet)
      + '. No wallet signature or broadcast was attempted.')
  }
  let energyUsed
  try { energyUsed = BigInt(response.energy_required ?? response.energy_used) } catch {
    throw new Error('TRON Mainnet deployment Energy estimate did not return a valid energy_required value.')
  }
  if (energyUsed <= 0n) throw new Error('TRON Mainnet deployment Energy estimate returned zero Energy; refusing to guess a deployment cost.')
  let energyPenalty = 0n
  try { energyPenalty = BigInt(response.energy_penalty ?? 0) } catch {
    throw new Error('TRON Mainnet deployment simulation returned an invalid Energy penalty.')
  }
  if (energyPenalty < 0n) {
    throw new Error('TRON Mainnet deployment simulation returned an invalid Energy penalty.')
  }
  return { energyUsed: energyUsed.toString(), energyPenalty: energyPenalty.toString() }
}

export function calculateDeploymentResourceBudget({
  energyRequired,
  resourceSnapshot,
  rawDataHex,
  feeLimitSun,
  safetyMarginBps = 12500,
  transactionLabel = 'deployment',
}) {
  let energy, feeLimit
  try {
    energy = BigInt(energyRequired)
    feeLimit = BigInt(feeLimitSun)
  } catch { throw new Error('Deployment Energy estimate or fee limit is invalid.') }
  if (energy <= 0n || feeLimit <= 0n || !Number.isInteger(safetyMarginBps) || safetyMarginBps < 10000 || safetyMarginBps > 20000) {
    throw new Error('Deployment resource budget inputs are outside the allowed range.')
  }
  if (!/^(?:[0-9a-f]{2})+$/i.test(String(rawDataHex || ''))) {
    throw new Error('Deployment transaction bytes are unavailable for Bandwidth estimation.')
  }
  const energyFee = BigInt(resourceSnapshot.energyFeeSun)
  const bandwidthFee = resourceSnapshot.bandwidthFeeSun == null ? null : BigInt(resourceSnapshot.bandwidthFeeSun)
  const availableEnergy = BigInt(resourceSnapshot.energyAvailable)
  // TRON does not pool free and staked/delegated Bandwidth for one transaction.
  // A single source must cover the complete byte cost; otherwise the network
  // burns TRX for the full Bandwidth cost rather than only the uncovered bytes.
  const freeBandwidth = BigInt(resourceSnapshot.freeBandwidthAvailable)
  const stakedBandwidth = BigInt(resourceSnapshot.stakedBandwidthAvailable)
  const availableBandwidth = freeBandwidth > stakedBandwidth ? freeBandwidth : stakedBandwidth
  const maxFeeLimit = resourceSnapshot.maxFeeLimitSun == null ? null : BigInt(resourceSnapshot.maxFeeLimitSun)
  if (energyFee <= 0n) throw new Error('Mainnet returned an invalid Energy price.')
  if (maxFeeLimit === null || maxFeeLimit <= 0n) {
    throw new Error('TRON Mainnet did not return getMaxFeeLimit. Cannot validate the deployment fee cap safely.')
  }
  const bufferedEnergy = (energy * BigInt(safetyMarginBps) + 9999n) / 10000n
  const requiredFeeLimit = bufferedEnergy * energyFee
  if (requiredFeeLimit > maxFeeLimit) {
    throw new Error('Estimated ' + transactionLabel + ' Energy with the safety margin requires a fee cap above the current TRON Mainnet maximum. Reduce operation complexity; this transaction cannot be safely budgeted.')
  }
  if (feeLimit > maxFeeLimit) {
    throw new Error('Selected fee cap exceeds the current TRON Mainnet maximum of ' + maxFeeLimit.toString() + ' SUN.')
  }
  if (feeLimit < requiredFeeLimit) {
    throw new Error('Selected fee cap is too low for the estimated ' + transactionLabel + '. Required at least ' + requiredFeeLimit.toString() + ' SUN (' + (Number(requiredFeeLimit) / 1e6).toFixed(6) + ' TRX) with the safety margin.')
  }
  const energyShortfall = bufferedEnergy > availableEnergy ? bufferedEnergy - availableEnergy : 0n
  const estimatedBandwidthBytes = BigInt(Math.ceil(rawDataHex.length / 2) + 3 + 64 + 67)
  // Energy can be covered partially, but Bandwidth requires one complete
  // quota source. If neither source covers the whole transaction, all bytes
  // fall back to TRX rather than just the difference between quotas and bytes.
  const bandwidthShortfall = estimatedBandwidthBytes > availableBandwidth ? estimatedBandwidthBytes : 0n

  const energyBurnSun = energyShortfall * energyFee
  if (bandwidthShortfall > 0n && (bandwidthFee === null || bandwidthFee <= 0n)) {
    throw new Error('TRON Mainnet did not return a valid Bandwidth fee. Cannot safely estimate the TRX fallback.')
  }
  const bandwidthBurnSun = bandwidthShortfall * (bandwidthFee || 0n)
  const requiredTrxSun = energyBurnSun + bandwidthBurnSun
  if (requiredTrxSun > 0n) {
    const energyStatus = 'Energy required (with safety margin): ' + bufferedEnergy.toString()
      + '; available: ' + availableEnergy.toString()
      + '; shortfall: ' + energyShortfall.toString() + '.'
    const bandwidthStatus = 'Bandwidth bytes required: ' + estimatedBandwidthBytes.toString()
      + '; largest single available quota: ' + availableBandwidth.toString()
      + '; shortfall: ' + bandwidthShortfall.toString() + '.'
    const fallbackStatus = 'Estimated TRX fallback breakdown: Energy ' + (Number(energyBurnSun) / 1e6).toFixed(6)
      + ' TRX; Bandwidth ' + (Number(bandwidthBurnSun) / 1e6).toFixed(6)
      + ' TRX; total ' + (Number(requiredTrxSun) / 1e6).toFixed(6) + ' TRX.'
    throw new Error('ZERO-TRX-BURN PROTECTION BLOCKED ' + String(transactionLabel).toUpperCase() + '. '
      + energyStatus + ' ' + bandwidthStatus + ' ' + fallbackStatus
      + ' This policy requires zero TRX burn, so any resource shortfall blocks the wallet prompt. '
      + 'Obtain only the missing resource on this owner account, then run a fresh preflight. '
      + 'No wallet prompt, signature, or broadcast was attempted.')
  }
  return {
    energyRequired: energy.toString(),
    energyWithSafetyMargin: bufferedEnergy.toString(),
    availableEnergy: availableEnergy.toString(),
    energyShortfall: energyShortfall.toString(),
    estimatedBandwidthBytes: estimatedBandwidthBytes.toString(),
    availableBandwidth: availableBandwidth.toString(),
    bandwidthShortfall: bandwidthShortfall.toString(),
    energyBurnSun: energyBurnSun.toString(),
    bandwidthBurnSun: bandwidthBurnSun.toString(),
    requiredTrxSun: requiredTrxSun.toString(),
    feeLimitSun: feeLimit.toString(),
  }
}

export function isMainnetEnergyEstimateUnavailable(error) {
  const message = decodeNodeErrorText(error?.message || error || '')
  return /does not support estimate energy|estimateenergy.{0,50}(?:not supported|disabled|unavailable)|(?:not supported|disabled|unavailable).{0,50}estimateenergy|HTTP (?:404|405|501).*estimateenergy/i.test(message)
}

export function assertZeroTrxBurnBudget(resourceBudget) {
  const required = BigInt(resourceBudget?.requiredTrxSun ?? -1)
  if (required < 0n) throw new Error('Deployment resource budget is unavailable; refusing a zero-cost deployment claim.')
  if (required > 0n) {
    const energy = BigInt(resourceBudget.energyBurnSun ?? 0)
    const bandwidth = BigInt(resourceBudget.bandwidthBurnSun ?? 0)
    throw new Error('Zero-TRX deployment preflight blocked: this owner account would burn '
      + (Number(required) / 1e6).toFixed(6) + ' TRX (Energy: '
      + (Number(energy) / 1e6).toFixed(6) + ' TRX; Bandwidth: '
      + (Number(bandwidth) / 1e6).toFixed(6) + ' TRX). Obtain enough Energy and Bandwidth on the same owner address before signing. No wallet prompt, signature, or broadcast was attempted.')
  }
  return true
}

export async function estimateMainnetContractCallEnergy(
  tronWeb,
  contractAddress,
  encodedCallData,
  ownerAddress,
  requestNode
) {
  if (typeof requestNode !== 'function') throw new Error('A paced Mainnet RPC request function is required for Energy estimation.')
  if (!tronWeb?.isAddress?.(contractAddress) || !tronWeb?.isAddress?.(ownerAddress)) {
    throw new Error('A valid TRӾ contract and transaction-owner address are required for Energy simulation.')
  }
  const data = String(encodedCallData || '').replace(/^0x/, '')
  if (!/^(?:[0-9a-f]{2}){4,}$/i.test(data)) {
    throw new Error('The exact encoded TRӾ contract-call data is missing or malformed; refusing to estimate or sign.')
  }
  const request = {
    owner_address: tronWeb.address.toHex(ownerAddress),
    contract_address: tronWeb.address.toHex(contractAddress),
    data,
    call_value: 0,
    visible: false,
  }
  try {
    const response = await requestNode(tronWeb, '/wallet/estimateenergy', request)
    return normalizeDeploymentEnergyEstimate(response)
  } catch (error) {
    if (!isMainnetEnergyEstimateUnavailable(error)) throw error
    try {
      const response = await requestNode(tronWeb, '/wallet/triggerconstantcontract', request)
      return normalizeDeploymentEnergyEstimate(response)
    } catch (fallbackError) {
      throw new Error('TRON Mainnet could not simulate the exact encoded TRӾ contract call for Energy. Refusing to request a signature. '
        + String(fallbackError?.message || fallbackError))
    }
  }
}
