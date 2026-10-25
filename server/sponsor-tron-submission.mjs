import { createHash } from 'node:crypto'
import { TronWeb } from 'tronweb'
import { isValidTronAddress } from './tron-address.mjs'
import { isPositiveUint256 } from './base-units.mjs'

const NETWORKS = Object.freeze({
  shasta: 'https://api.shasta.trongrid.io',
  nile: 'https://nile.trongrid.io',
})
const MAX_SIGNED_TRANSACTION_BYTES = 128 * 1024
const MAX_TRANSACTION_LIFETIME_MS = 10 * 60 * 1000
const MAX_CLOCK_SKEW_MS = 30 * 1000
const DEFAULT_MAX_FEE_LIMIT_SUN = '50000000'
const TX_ID = /^[0-9a-f]{64}$/i
const HEX = /^(?:[0-9a-f]{2})+$/i

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]))
  }
  return value
}

function fail(reason, extra = {}) {
  return { success: false, status: reason, reason, ...extra }
}

function safeBaseUnits(value) {
  if (typeof value === 'string' && isPositiveUint256(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  return null
}

function transferShape(transfer) {
  if (!transfer || typeof transfer !== 'object') return 'invalid-transfer-intent'
  if (!Object.hasOwn(NETWORKS, transfer.network)) return 'unsupported-testnet'
  if (transfer.purpose !== 'asset-grant') return 'asset-principal-transfer-required'
  if (!['pending-review', 'broadcasting', 'submitted'].includes(transfer.status)) return 'transfer-not-submittable'
  if (typeof transfer.sponsorAddress !== 'string' || !isValidTronAddress(transfer.sponsorAddress)
    || typeof transfer.receiverAddress !== 'string' || !isValidTronAddress(transfer.receiverAddress)
    || !safeBaseUnits(transfer.amountBaseUnits)) return 'invalid-transfer-intent'
  if (!['TRX', 'USDT', 'VTRC'].includes(transfer.asset)) return 'unsupported-asset'
  if (transfer.asset === 'TRX' && transfer.tokenContract != null && transfer.tokenContract !== '') {
    return 'native-trx-contract-must-be-empty'
  }
  if (transfer.asset !== 'TRX'
    && (typeof transfer.tokenContract !== 'string' || !isValidTronAddress(transfer.tokenContract))) {
    return 'invalid-token-contract'
  }
  return null
}

function addressHex(tronWeb, address) {
  const hex = tronWeb.address.toHex(address)
  if (typeof hex !== 'string' || !/^41[0-9a-f]{40}$/i.test(hex)) {
    throw new Error('invalid-tron-address-encoding')
  }
  return hex.toLowerCase()
}

function tronWebFor(network, tronWebFactory = (host) => new TronWeb({ fullHost: host })) {
  const host = NETWORKS[network]
  if (!host) throw new Error('unsupported-testnet')
  return { host, tronWeb: tronWebFactory(host) }
}

function maxFeeLimitSun(env) {
  const configured = env.SPONSOR_TESTNET_MAX_FEE_LIMIT_SUN || DEFAULT_MAX_FEE_LIMIT_SUN
  if (!/^[1-9][0-9]{0,15}$/.test(configured)) return null
  const parsed = BigInt(configured)
  return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : null
}

/**
 * Build a transaction for a previously reserved asset-principal intent.
 * Only TRON testnets are admitted; Mainnet never uses this path.
 */
export async function buildSponsorUnsignedTransaction({
  transfer,
  env = process.env,
  tronWebFactory,
}) {
  const invalid = transferShape(transfer)
  if (invalid) return fail(invalid)
  if (transfer.status !== 'pending-review') return fail('transfer-not-pending-review')

  const amountBaseUnits = safeBaseUnits(transfer.amountBaseUnits)
  const { tronWeb } = tronWebFor(transfer.network, tronWebFactory)
  try {
    const senderHex = addressHex(tronWeb, transfer.sponsorAddress)
    addressHex(tronWeb, transfer.receiverAddress)
    if (transfer.asset !== 'TRX') addressHex(tronWeb, transfer.tokenContract)

    let transaction
    if (transfer.asset === 'TRX') {
      const amount = BigInt(amountBaseUnits)
      // TronWeb's native-transfer builder takes a JS number in sun. Reject values
      // it cannot represent exactly instead of silently rounding an amount.
      if (amount > BigInt(Number.MAX_SAFE_INTEGER)) return fail('amount-exceeds-safe-native-transfer-range')
      transaction = await tronWeb.transactionBuilder.sendTrx(
        transfer.receiverAddress,
        Number(amount),
        transfer.sponsorAddress,
      )
    } else {
      const feeLimitSun = maxFeeLimitSun(env)
      if (!feeLimitSun) return fail('invalid-testnet-fee-limit')
      const result = await tronWeb.transactionBuilder.triggerSmartContract(
        transfer.tokenContract,
        'transfer(address,uint256)',
        {
          feeLimit: feeLimitSun,
          callValue: 0,
          from: transfer.sponsorAddress,
          shouldPollResponse: false,
        },
        [
          { type: 'address', value: transfer.receiverAddress },
          { type: 'uint256', value: amountBaseUnits },
        ],
        transfer.sponsorAddress,
      )
      if (result?.result?.result !== true || !result.transaction) {
        return fail('unsigned-token-transaction-build-failed')
      }
      transaction = result.transaction
    }

    if (!transaction || typeof transaction.raw_data_hex !== 'string'
      || !HEX.test(transaction.raw_data_hex) || !TX_ID.test(transaction.txID || '')) {
      return fail('unsigned-transaction-incomplete')
    }
    const rawDataHash = createHash('sha256')
      .update(Buffer.from(transaction.raw_data_hex, 'hex'))
      .digest('hex')
    if (rawDataHash.toLowerCase() !== transaction.txID.toLowerCase()) {
      return fail('unsigned-transaction-hash-mismatch')
    }
    return {
      success: true,
      status: 'unsigned-testnet-transaction-prepared',
      network: transfer.network,
      sponsorAddress: transfer.sponsorAddress,
      receiverAddress: transfer.receiverAddress,
      asset: transfer.asset,
      tokenContract: transfer.asset === 'TRX' ? null : transfer.tokenContract,
      amountBaseUnits,
      transaction,
      canSubmitSponsoredTransfer: false,
      submissionEnabled: false,
      note: 'Preparation only. The sponsor wallet must explicitly sign this transaction, the backend must revalidate the signed bytes, and the sponsor fee/resource-coverage gate must pass before broadcast.',
    }
  } catch (error) {
    return fail(error?.message === 'unsupported-testnet' ? 'unsupported-testnet' : 'unsigned-transaction-build-failed')
  }
}

/**
 * Validates the signed transaction's exact transfer semantics and signature
 * permission using the selected testnet node. It does not broadcast anything.
 */
export async function validateSponsorSignedTransaction({
  transfer,
  signedTransaction,
  expectedUnsignedTransaction = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
  tronWebFactory,
  now = () => Date.now(),
}) {
  const invalid = transferShape(transfer)
  if (invalid) return fail(invalid)
  if (typeof fetchImpl !== 'function') return fail('chain-provider-unavailable')
  if (!signedTransaction || typeof signedTransaction !== 'object' || Array.isArray(signedTransaction)) {
    return fail('signed-transaction-required')
  }

  let serialized
  try { serialized = JSON.stringify(signedTransaction) } catch { return fail('invalid-signed-transaction') }
  if (serialized.length > MAX_SIGNED_TRANSACTION_BYTES) return fail('signed-transaction-too-large')

  const rawDataHex = signedTransaction.raw_data_hex
  const claimedTxId = signedTransaction.txID
  if (expectedUnsignedTransaction) {
    if (typeof expectedUnsignedTransaction.raw_data_hex !== 'string'
      || typeof expectedUnsignedTransaction.txID !== 'string'
      || String(rawDataHex || '').toLowerCase() !== expectedUnsignedTransaction.raw_data_hex.toLowerCase()
      || String(claimedTxId || '').toLowerCase() !== expectedUnsignedTransaction.txID.toLowerCase()
      || JSON.stringify(canonicalJson(signedTransaction.raw_data))
        !== JSON.stringify(canonicalJson(expectedUnsignedTransaction.raw_data))) {
      return fail('signed-transaction-does-not-match-persisted-signing-intent')
    }
  }
  if (typeof rawDataHex !== 'string' || !HEX.test(rawDataHex)
    || typeof claimedTxId !== 'string' || !TX_ID.test(claimedTxId)
    || !Array.isArray(signedTransaction.signature) || signedTransaction.signature.length === 0
    || signedTransaction.signature.length > 10
    || signedTransaction.signature.some((signature) => typeof signature !== 'string' || !/^[0-9a-f]{130}$/i.test(signature))) {
    return fail('signed-transaction-shape-invalid')
  }

  const computedTxId = createHash('sha256')
    .update(Buffer.from(rawDataHex, 'hex'))
    .digest('hex')
  if (computedTxId.toLowerCase() !== claimedTxId.toLowerCase()) return fail('transaction-id-mismatch')

  const raw = signedTransaction.raw_data
  if (!raw || !Array.isArray(raw.contract) || raw.contract.length !== 1
    || !Number.isSafeInteger(raw.timestamp) || !Number.isSafeInteger(raw.expiration)) {
    return fail('transaction-contract-shape-invalid')
  }
  const currentTime = now()
  if (raw.timestamp < currentTime - MAX_CLOCK_SKEW_MS
    || raw.timestamp > currentTime + MAX_CLOCK_SKEW_MS
    || raw.expiration <= currentTime
    || raw.expiration <= raw.timestamp
    || raw.expiration - raw.timestamp > MAX_TRANSACTION_LIFETIME_MS) {
    return fail('transaction-expired-or-lifetime-invalid')
  }

  let host, tronWeb
  try {
    ({ host, tronWeb } = tronWebFor(transfer.network, tronWebFactory))
  } catch { return fail('unsupported-testnet') }

  const contract = raw.contract[0]
  const value = contract?.parameter?.value
  const expectedContractType = transfer.asset === 'TRX' ? 'TransferContract' : 'TriggerSmartContract'
  if (!value || contract.parameter.type_url !== `type.googleapis.com/protocol.${expectedContractType}`
    || contract.type !== expectedContractType) {
    return fail('transaction-contract-type-mismatch')
  }

  try {
    const expectedSender = addressHex(tronWeb, transfer.sponsorAddress)
    const expectedReceiver = addressHex(tronWeb, transfer.receiverAddress)
    if (String(value.owner_address || '').toLowerCase() !== expectedSender) {
      return fail('transaction-sponsor-address-mismatch')
    }

    if (transfer.asset === 'TRX') {
      const amount = safeBaseUnits(transfer.amountBaseUnits)
      const chainAmount = typeof value.amount === 'number'
        ? (Number.isSafeInteger(value.amount) && value.amount >= 0 ? String(value.amount) : null)
        : typeof value.amount === 'string' && /^(0|[1-9][0-9]*)$/.test(value.amount)
          ? value.amount : null
      if (String(value.to_address || '').toLowerCase() !== expectedReceiver || chainAmount !== amount) {
        return fail('transaction-transfer-intent-mismatch')
      }
      if (value.data || value.contract_address || value.call_value) return fail('unexpected-native-transfer-fields')
    } else {
      const expectedContract = addressHex(tronWeb, transfer.tokenContract)
      const callData = String(value.data || '').toLowerCase()
      const receiverArgument = expectedReceiver.slice(2) // Drop TRON's 0x41 version byte.
      const amountArgument = BigInt(transfer.amountBaseUnits).toString(16).padStart(64, '0')
      const expectedData = `a9059cbb${receiverArgument.padStart(64, '0')}${amountArgument}`
      const maxFee = maxFeeLimitSun(env)
      const feeLimit = raw.fee_limit
      if (String(value.contract_address || '').toLowerCase() !== expectedContract
        || callData !== expectedData
        || BigInt(String(value.call_value || 0)) !== 0n
        || !Number.isSafeInteger(feeLimit) || feeLimit <= 0
        || maxFee === null || feeLimit > maxFee) {
        return fail('transaction-token-transfer-intent-mismatch')
      }
    }
  } catch {
    return fail('transaction-address-or-value-invalid')
  }

  let weight
  try {
    const response = await fetchImpl(`${host}/wallet/getsignweight`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(env.TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': env.TRONGRID_API_KEY } : {}),
      },
      body: JSON.stringify(signedTransaction),
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) return fail('signature-verification-provider-http-error', { providerStatus: response.status })
    weight = await response.json()
  } catch {
    return fail('signature-verification-provider-unreachable')
  }

  const detail = weight?.data && typeof weight.data === 'object' ? weight.data : weight
  const nodeTx = detail?.transaction?.transaction || detail?.transaction || null
  if (nodeTx?.txID && String(nodeTx.txID).toLowerCase() !== computedTxId.toLowerCase()) {
    return fail('node-signature-check-transaction-id-mismatch')
  }
  if (nodeTx?.raw_data_hex && String(nodeTx.raw_data_hex).toLowerCase() !== rawDataHex.toLowerCase()) {
    return fail('node-signature-check-raw-data-mismatch')
  }
  const resultDetail = detail?.result
  const resultCode = typeof resultDetail?.code === 'string' ? resultDetail.code : null
  const enoughPermission = resultCode === 'ENOUGH_PERMISSION'
    || (resultCode === null && resultDetail?.result === true)
    || (resultCode === null && detail?.result === true)
  const explicitFailure = resultDetail?.result === false || resultDetail === false
    || (resultCode !== null && resultCode !== 'ENOUGH_PERMISSION')
  const threshold = detail?.permission?.threshold
  const currentWeight = detail?.current_weight
  if (!enoughPermission || explicitFailure || !Number.isSafeInteger(threshold) || threshold <= 0
    || !Number.isSafeInteger(currentWeight) || currentWeight < threshold) {
    return fail('sponsor-signature-permission-not-satisfied')
  }

  return {
    success: true,
    status: 'sponsor-signature-verified',
    network: transfer.network,
    txID: computedTxId,
    sponsorAddress: transfer.sponsorAddress,
    receiverAddress: transfer.receiverAddress,
    asset: transfer.asset,
    tokenContract: transfer.asset === 'TRX' ? null : transfer.tokenContract,
    amountBaseUnits: transfer.amountBaseUnits,
    signaturePermissionVerified: true,
    canSubmitSponsoredTransfer: false,
    submissionEnabled: false,
  }
}

/**
 * Broadcast an already-validated signed transaction to the fixed network node.
 * The response must explicitly confirm both acceptance and the expected txid.
 */
export async function broadcastValidatedSponsorTransaction({
  network,
  signedTransaction,
  expectedTxID,
  env = process.env,
  fetchImpl = globalThis.fetch,
}) {
  const host = NETWORKS[network]
  if (!host) return fail('unsupported-testnet')
  if (!signedTransaction || typeof signedTransaction !== 'object'
    || typeof expectedTxID !== 'string' || !TX_ID.test(expectedTxID)) {
    return fail('validated-signed-transaction-required')
  }
  const rawHash = typeof signedTransaction.raw_data_hex === 'string' && HEX.test(signedTransaction.raw_data_hex)
    ? createHash('sha256').update(Buffer.from(signedTransaction.raw_data_hex, 'hex')).digest('hex')
    : null
  if (!rawHash || rawHash.toLowerCase() !== expectedTxID.toLowerCase()
    || String(signedTransaction.txID || '').toLowerCase() !== expectedTxID.toLowerCase()) {
    return fail('transaction-id-mismatch')
  }

  try {
    const response = await fetchImpl(`${host}/wallet/broadcasttransaction`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(env.TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': env.TRONGRID_API_KEY } : {}),
      },
      body: JSON.stringify(signedTransaction),
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) return fail('broadcast-provider-http-error', { providerStatus: response.status })
    const payload = await response.json()
    if (payload?.result !== true || String(payload.txid || '').toLowerCase() !== expectedTxID.toLowerCase()) {
      return fail('broadcast-not-confirmed-by-node', {
        providerCode: typeof payload?.code === 'string' ? payload.code.slice(0, 80) : undefined,
      })
    }
    return {
      success: true,
      status: 'broadcast-accepted',
      network,
      txID: expectedTxID.toLowerCase(),
      providerAccepted: true,
      chainFinalityVerified: false,
      canSubmitSponsoredTransfer: false,
      submissionEnabled: false,
      note: 'The node accepted the signed transaction for broadcast. This is not proof of solidification or receiver balance; reconcile from exact-network chain evidence.',
    }
  } catch {
    return fail('broadcast-provider-unreachable')
  }
}

/**
 * Read actual current account resources and, for TRC-20, simulate contract
 * execution before a sponsor signs or broadcasts. An active delegation alone
 * is not capacity evidence, so callers must require this check to pass too.
 */
export async function verifySponsorFeeResourceCapacity({
  transfer,
  transaction,
  env = process.env,
  fetchImpl = globalThis.fetch,
  tronWebFactory,
}) {
  const invalid = transferShape(transfer)
  if (invalid) return fail(invalid)
  if (!transaction || typeof transaction.raw_data_hex !== 'string' || !HEX.test(transaction.raw_data_hex)
    || !transaction.raw_data?.contract?.[0]?.parameter?.value) {
    return fail('unsigned-transaction-required')
  }
  let host, tronWeb
  try {
    ({ host, tronWeb } = tronWebFor(transfer.network, tronWebFactory))
  } catch { return fail('unsupported-testnet') }

  let senderHex
  try { senderHex = addressHex(tronWeb, transfer.sponsorAddress) } catch { return fail('invalid-sponsor-address') }
  const signedBytesEstimate = Buffer.from(transaction.raw_data_hex, 'hex').length
    + Math.max(1, Array.isArray(transaction.signature) ? transaction.signature.length : 1) * 67
    + 32
  const postJson = async (path, body) => {
    const response = await fetchImpl(`${host}${path}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(env.TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': env.TRONGRID_API_KEY } : {}),
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) throw Object.assign(new Error('resource-provider-http-error'), { providerStatus: response.status })
    const payload = await response.json()
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.Error) {
      throw new Error('invalid-resource-provider-response')
    }
    return payload
  }
  const integer = (value) => {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
    if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value)
    return null
  }

  try {
    const resources = await postJson('/wallet/getaccountresource', {
      address: senderHex,
      visible: false,
    })
    const energyLimit = integer(resources.EnergyLimit ?? 0)
    const energyUsed = integer(resources.EnergyUsed ?? 0)
    const netLimit = integer(resources.NetLimit ?? 0)
    const netUsed = integer(resources.NetUsed ?? 0)
    const freeNetLimit = integer(resources.freeNetLimit ?? 0)
    const freeNetUsed = integer(resources.freeNetUsed ?? 0)
    if (energyLimit === null || energyUsed === null || netLimit === null || netUsed === null
      || freeNetLimit === null || freeNetUsed === null) {
      return fail('sponsor-resource-response-incomplete')
    }
    const availableEnergy = energyLimit > energyUsed ? energyLimit - energyUsed : 0n
    const delegatedBandwidthAndFree = (netLimit > netUsed ? netLimit - netUsed : 0n)
      + (freeNetLimit > freeNetUsed ? freeNetLimit - freeNetUsed : 0n)
    let requiredEnergy = 0n
    if (transfer.asset !== 'TRX') {
      const contract = transaction.raw_data.contract[0]
      const value = contract?.parameter?.value
      if (contract.type !== 'TriggerSmartContract' || !value
        || typeof value.contract_address !== 'string' || typeof value.data !== 'string'
        || !HEX.test(value.data)) {
        return fail('token-contract-call-missing')
      }
      const callData = String(value.data).toLowerCase()
      if (callData.length < 8 || !/^[0-9a-f]+$/.test(callData)) {
        return fail('token-contract-call-missing')
      }
      const simulation = await postJson('/wallet/triggerconstantcontract', {
        owner_address: senderHex,
        contract_address: value.contract_address,
        function_selector: callData.slice(0, 8),
        parameter: callData.slice(8),
        visible: false,
      })
      const energyUsedEstimate = integer(simulation.energy_used)
      const simulatedContractRet = simulation.transaction?.ret?.[0]?.contractRet
      if (simulation.result?.result !== true
        || (simulatedContractRet !== undefined && simulatedContractRet !== 'SUCCESS')
        || energyUsedEstimate === null || energyUsedEstimate <= 0n) {
        return fail('token-energy-estimate-unavailable')
      }
      // Reserve a 25% safety margin for dynamic token execution paths.
      requiredEnergy = (energyUsedEstimate * 125n + 99n) / 100n
    }
    if (delegatedBandwidthAndFree < BigInt(signedBytesEstimate)) {
      return fail('sponsor-bandwidth-capacity-insufficient', {
        requiredBandwidthUnits: String(signedBytesEstimate),
        availableBandwidthUnits: delegatedBandwidthAndFree.toString(),
      })
    }
    if (availableEnergy < requiredEnergy) {
      return fail('sponsor-energy-capacity-insufficient', {
        requiredEnergyUnits: requiredEnergy.toString(),
        availableEnergyUnits: availableEnergy.toString(),
      })
    }
    return {
      success: true,
      status: 'sponsor-resource-capacity-verified',
      network: transfer.network,
      sponsorAddress: transfer.sponsorAddress,
      availableEnergyUnits: availableEnergy.toString(),
      requiredEnergyUnits: requiredEnergy.toString(),
      availableBandwidthUnits: delegatedBandwidthAndFree.toString(),
      requiredBandwidthUnits: String(signedBytesEstimate),
      signedTransactionBytesEstimated: true,
      resourceSource: 'selected testnet wallet/getaccountresource plus token constant-contract simulation',
      canSubmitSponsoredTransfer: false,
      submissionEnabled: false,
      note: 'This is a point-in-time capacity preflight, not final fee evidence. Recheck after sponsor signing and reconcile actual resource/fee consumption after confirmation.',
    }
  } catch (error) {
    return fail(Number.isInteger(error?.providerStatus)
      ? 'sponsor-resource-provider-http-error'
      : 'sponsor-resource-provider-unavailable', {
      ...(Number.isInteger(error?.providerStatus) ? { providerStatus: error.providerStatus } : {}),
    })
  }
}

export const SPONSOR_TESTNET_NETWORKS = Object.freeze(Object.keys(NETWORKS))
