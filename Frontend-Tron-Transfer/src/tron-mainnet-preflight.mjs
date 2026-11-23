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

export function decodeNodeErrorText(value) {
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


export function assertTransactionIntegrity(tronWeb, transaction, stage = 'TRON transaction') {
  const check = tronWeb?.utils?.transaction?.txCheck
  if (typeof check !== 'function') {
    throw new Error('TronWeb transaction integrity checker is unavailable; refusing to sign or broadcast.')
  }
  let valid = false
  try { valid = check(transaction) === true } catch {}
  if (!valid) {
    throw new Error(stage + ' failed TronWeb protobuf integrity validation: raw_data, raw_data_hex and txID do not describe the same transaction. Nothing was signed or broadcast.')
  }
  return true
}

export function verifyTransactionSigner(tronWeb, transaction, expectedAddress) {
  const contract = transaction?.raw_data?.contract?.[0]
  const ownerHex = contract?.parameter?.value?.owner_address
  const signatures = transaction?.signature
  if (typeof ownerHex !== 'string' || !/^(?:41)?[0-9a-f]{40,42}$/i.test(ownerHex)) {
    throw new Error('Deployment transaction is missing a valid owner_address; refusing broadcast.')
  }
  if (!Array.isArray(signatures) || signatures.length !== 1
    || typeof signatures[0] !== 'string' || !/^[0-9a-f]{130}$/i.test(signatures[0])) {
    throw new Error('Deployment requires exactly one valid 65-byte Owner Wallet signature; refusing broadcast.')
  }
  const crypto = tronWeb?.utils?.crypto
  if (typeof crypto?.ecRecover !== 'function') {
    throw new Error('This TronWeb client cannot independently recover TRON transaction signers; refusing broadcast.')
  }
  let transactionOwner
  let recoveredSigner
  try {
    transactionOwner = ownerHex.length === 42 ? tronWeb.address.fromHex(ownerHex) : tronWeb.address.fromHex('41' + ownerHex)
    const recovered = crypto.ecRecover(transaction.txID, signatures[0])
    // TronWeb's ecRecover returns the 21-byte TRON address in 41-prefixed hex,
    // not Base58Check. Normalize it before comparing with the wallet account.
    recoveredSigner = typeof recovered === 'string' && /^41[0-9a-f]{40}$/i.test(recovered)
      ? tronWeb.address.fromHex(recovered)
      : recovered
  } catch {
    throw new Error('Unable to recover the signer from the TRON transaction signature; refusing broadcast.')
  }
  if (!tronWeb.isAddress(transactionOwner) || !tronWeb.isAddress(recoveredSigner)
    || !addressesEqual(tronWeb, transactionOwner, expectedAddress)
    || !addressesEqual(tronWeb, recoveredSigner, transactionOwner)) {
    throw new Error('TRON signature signer does not match both the deployment owner_address and connected wallet. Nothing was broadcast.')
  }
  return { ownerAddress: transactionOwner, recoveredAddress: recoveredSigner }
}

export async function assertTransactionPermission(tronWeb, signedTransaction, expectedSigner) {
  if (typeof tronWeb?.trx?.getSignWeight !== 'function') {
    throw new Error('TRON permission preflight is unavailable; refusing to broadcast.')
  }
  if (!expectedSigner || !tronWeb?.isAddress?.(expectedSigner)) {
    throw new Error('Expected connected TRON signer is missing or invalid; refusing to broadcast.')
  }
  let result
  try {
    result = await tronWeb.trx.getSignWeight(signedTransaction)
  } catch (error) {
    throw new Error('TRON permission preflight failed; refusing to broadcast. ' + (error?.message || String(error)))
  }

  const contract = signedTransaction?.raw_data?.contract?.[0]
  const requestedPermissionId = Number(contract?.Permission_id ?? contract?.permission_id ?? 0)
  const permission = result?.permission
  const permissionId = permission?.id ?? (String(permission?.permission_name || '').toLowerCase() === 'owner' ? 0 : undefined)
  const weight = result?.current_weight
  const threshold = permission?.threshold
  const approved = Array.isArray(result?.approved_list) ? result.approved_list : []
  const keys = Array.isArray(permission?.keys) ? permission.keys : []

  const signerApproved = approved.some(address => addressesEqual(tronWeb, address, expectedSigner))
  const signerKey = keys.find(key => addressesEqual(tronWeb, key?.address, expectedSigner))
  const keyWeight = Number(signerKey?.weight)
  const hasCompleteWeightEvidence = Number.isSafeInteger(Number(weight))
    && Number(weight) >= 0
    && Number.isSafeInteger(Number(threshold))
    && Number(threshold) > 0
    && signerApproved
    && signerKey
    && Number.isSafeInteger(keyWeight)
    && keyWeight > 0
    && (permissionId === undefined || permissionId === requestedPermissionId)

  const rawCode = result?.result?.code
  const numericWeightMeetsThreshold = Number.isSafeInteger(Number(weight))
    && Number(weight) >= 0
    && Number.isSafeInteger(Number(threshold))
    && Number(threshold) > 0
    && Number(weight) >= Number(threshold)
  if (rawCode == null && numericWeightMeetsThreshold && !signerApproved) {
    throw new Error('TRON node reported enough signing weight but its approved_list does not include the connected wallet signer. Nothing was broadcast.')
  }
  if (rawCode == null && numericWeightMeetsThreshold && !signerKey) {
    throw new Error('TRON node reported enough signing weight but the connected wallet is not a key in the selected permission. Nothing was broadcast.')
  }
  // java-tron defines ENOUGH_PERMISSION as enum value 0. Proto3 omits
  // default-valued enum fields from JSON, so a successful response commonly
  // arrives as result: {} rather than result: { code: "ENOUGH_PERMISSION" }.
  const normalizedCode = rawCode === 0 || rawCode === '0'
    ? 'ENOUGH_PERMISSION'
    : rawCode === 1 || rawCode === '1'
      ? 'NOT_ENOUGH_PERMISSION'
      : rawCode
  const successFromCode = normalizedCode === 'ENOUGH_PERMISSION'
  const successFromWeight = rawCode == null
    && hasCompleteWeightEvidence
    && Number(weight) >= Number(threshold)

  if (normalizedCode === 'ENOUGH_PERMISSION' || successFromWeight) {
    if (!signerApproved || !signerKey || !Number.isSafeInteger(keyWeight) || keyWeight <= 0) {
      throw new Error('TRON permission preflight did not confirm that the connected signer is an approved key in the selected permission. Nothing was broadcast.')
    }
    if (permissionId !== undefined && permissionId !== requestedPermissionId) {
      throw new Error('TRON permission preflight selected permission ID ' + permissionId + ' but the transaction requests permission ID ' + requestedPermissionId + '. Nothing was broadcast.')
    }
    if (!Number.isSafeInteger(Number(weight)) || !Number.isSafeInteger(Number(threshold))
      || Number(weight) < Number(threshold)) {
      throw new Error('TRON permission result claimed success but its reported signing weight does not satisfy the permission threshold. Nothing was broadcast.')
    }
    return result
  }

  let message = result?.result?.message || normalizedCode || 'missing permission result'
  try { if (typeof message === 'string' && /^(?:[0-9a-f]{2})+$/i.test(message)) message = tronWeb.toUtf8(message) } catch {}
  const details = [
    Number.isFinite(Number(weight)) ? 'collected weight ' + weight : '',
    Number.isFinite(Number(threshold)) ? 'required threshold ' + threshold : '',
    permissionId !== undefined ? 'permission ID ' + permissionId : '',
    approved.length ? 'approved signers ' + approved.join(', ') : '',
    signerKey ? 'connected key weight ' + keyWeight : 'connected signer absent from permission keys',
  ].filter(Boolean).join('; ')
  const nextStep = normalizedCode === 'NOT_ENOUGH_PERMISSION'
    ? ' The connected wallet signature does not meet the selected account permission threshold. Check the transaction Permission_id and account keys.'
    : ''
  throw new Error('TRON signer does not satisfy the account permission threshold (' + (normalizedCode || 'unknown') + '). Nothing was broadcast. ' + message + (details ? ' Permission diagnostics: ' + details + '.' : '') + nextStep)
}
