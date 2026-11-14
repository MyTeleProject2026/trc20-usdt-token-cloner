import artifacts from './generated/trax-contract-artifacts.js'
export const TRON_MAINNET_HOST = 'https://api.trongrid.io'
export const TRAX_STORAGE_KEY = 'tron-transfer:trax-mainnet-contracts:v1'
export const TRAX_TOKEN_ARTIFACT = artifacts.token
export const TRAX_VAULT_ARTIFACT = artifacts.vault

export function assertMainnetWallet(wallet) {
  if (!wallet?.tronWeb || !wallet?.address) throw new Error('Connect a TronLink wallet first.')
  let host = ''
  try { host = new URL(String(wallet.tronWeb.fullNode?.host || '')).hostname.toLowerCase() } catch {}
  if (host !== 'api.trongrid.io') throw new Error('Wrong network. Switch TronLink to TRON Mainnet and reconnect.')
  if (!wallet.tronWeb.isAddress(wallet.address)) throw new Error('TronLink returned an invalid TRON address.')
  return wallet.tronWeb
}

export function parseTokenUnits(value) {
  const input = String(value ?? '').trim()
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(input) || !/[1-9]/.test(input)) {
    throw new Error('Enter a positive amount with no more than six decimal places.')
  }
  const [whole, fraction = ''] = input.split('.')
  return (BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'))).toString()
}

export function formatTokenUnits(value) {
  const amount = BigInt(String(value ?? '0'))
  const whole = amount / 1000000n
  const fraction = (amount % 1000000n).toString().padStart(6, '0').replace(/0+$/, '')
  return whole.toString() + (fraction ? '.' + fraction : '')
}

export function addressesEqual(tronWeb, a, b) {
  try { return tronWeb.address.toHex(String(a)).toLowerCase() === tronWeb.address.toHex(String(b)).toLowerCase() }
  catch { return false }
}

export function loadSavedContracts() {
  try {
    const value = JSON.parse(window.localStorage.getItem(TRAX_STORAGE_KEY) || '{}')
    return {
      tokenAddress: typeof value.tokenAddress === 'string' ? value.tokenAddress : '',
      vaultAddress: typeof value.vaultAddress === 'string' ? value.vaultAddress : '',
    }
  } catch { return { tokenAddress: '', vaultAddress: '' } }
}

export function saveContractAddresses(addresses) {
  const value = {
    tokenAddress: String(addresses.tokenAddress || ''),
    vaultAddress: String(addresses.vaultAddress || ''),
  }
  window.localStorage.setItem(TRAX_STORAGE_KEY, JSON.stringify(value))
}

async function postNode(tronWeb, path, body) {
  const response = await fetch(TRON_MAINNET_HOST + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  if (!response.ok) throw new Error('TRON Mainnet node returned HTTP ' + response.status + ' for ' + path)
  return response.json()
}

function resourceInteger(source, key) {
  const raw = source?.[key] ?? 0
  let value
  try { value = BigInt(raw) } catch { throw new Error('TRON returned an invalid resource field: ' + key) }
  if (value < 0n) throw new Error('TRON returned a negative resource field: ' + key)
  return value
}

export function normalizeMainnetAccountResources(accountResources, chainParameters, nativeBalanceSun) {
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
  const nativeBalance = BigInt(String(nativeBalanceSun ?? 0))
  const energyFee = parameter('getEnergyFee')
  const bandwidthFee = parameter('getTransactionFee')
  const maxFeeLimit = parameter('getMaxFeeLimit')
  if (nativeBalance < 0n) throw new Error('TRON returned a negative native TRX balance.')
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
    nativeBalanceSun: nativeBalance.toString(),
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

export async function getMainnetAccountPermissionSnapshot(tronWeb, address) {
  if (!tronWeb?.isAddress?.(address)) throw new Error('Enter a valid TRON Mainnet wallet address.')
  const account = await postNode(tronWeb, '/wallet/getaccount', { address, visible: true })
  return normalizeMainnetPermissionSnapshot(account, address, tronWeb)
}

export async function getMainnetAccountResourceSnapshot(tronWeb, address) {
  if (!tronWeb?.isAddress?.(address)) throw new Error('Enter a valid TRON Mainnet wallet address.')
  const [accountResources, chainParameters, nativeBalanceSun] = await Promise.all([
    postNode(tronWeb, '/wallet/getaccountresource', { address, visible: true }),
    postNode(tronWeb, '/wallet/getchainparameters', {}),
    tronWeb.trx.getBalance(address),
  ])
  return normalizeMainnetAccountResources(accountResources, chainParameters, nativeBalanceSun)
}

export function normalizeDeploymentEnergyEstimate(response) {
  if (!response || response.Error || response.result?.result !== true) {
    const detail = response?.result?.message || response?.result?.code || response?.Error || 'Mainnet node could not simulate contract creation'
    throw new Error('TRON Mainnet deployment Energy simulation failed: ' + detail)
  }
  let energyUsed
  try { energyUsed = BigInt(response.energy_used) } catch {
    throw new Error('TRON Mainnet deployment simulation did not return a valid energy_used value.')
  }
  if (energyUsed <= 0n) throw new Error('TRON Mainnet deployment simulation returned zero Energy; refusing to guess a deployment cost.')
  let energyPenalty = 0n
  try { energyPenalty = BigInt(response.energy_penalty ?? 0) } catch {
    throw new Error('TRON Mainnet deployment simulation returned an invalid Energy penalty.')
  }
  return { energyUsed: energyUsed.toString(), energyPenalty: energyPenalty.toString() }
}

export function calculateDeploymentResourceBudget({
  energyRequired,
  resourceSnapshot,
  rawDataHex,
  feeLimitSun,
  safetyMarginBps = 12000,
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
  const availableBandwidth = BigInt(resourceSnapshot.freeBandwidthAvailable) + BigInt(resourceSnapshot.stakedBandwidthAvailable)
  const balance = BigInt(resourceSnapshot.nativeBalanceSun)
  const maxFeeLimit = resourceSnapshot.maxFeeLimitSun == null ? null : BigInt(resourceSnapshot.maxFeeLimitSun)
  if (energyFee <= 0n || balance < 0n) throw new Error('Mainnet returned invalid Energy price or TRX balance.')
  const bufferedEnergy = (energy * BigInt(safetyMarginBps) + 9999n) / 10000n
  const requiredFeeLimit = bufferedEnergy * energyFee
  if (maxFeeLimit !== null && feeLimit > maxFeeLimit) {
    throw new Error('Selected fee cap exceeds the current TRON Mainnet maximum of ' + maxFeeLimit.toString() + ' SUN.')
  }
  if (feeLimit < requiredFeeLimit) {
    throw new Error('Selected fee cap is too low for the estimated deployment. Required at least ' + requiredFeeLimit.toString() + ' SUN (' + (Number(requiredFeeLimit) / 1e6).toFixed(6) + ' TRX) with the safety margin.')
  }
  const energyShortfall = bufferedEnergy > availableEnergy ? bufferedEnergy - availableEnergy : 0n
  const estimatedBandwidthBytes = BigInt(Math.ceil(rawDataHex.length / 2) + 3 + 64 + 67)
  const bandwidthShortfall = estimatedBandwidthBytes > availableBandwidth ? estimatedBandwidthBytes - availableBandwidth : 0n
  if (bandwidthShortfall > 0n && bandwidthFee === null) {
    throw new Error('Bandwidth fee is unavailable and the account does not have enough Bandwidth. Refusing to estimate the missing fee.')
  }
  const energyBurnSun = energyShortfall * energyFee
  const bandwidthBurnSun = bandwidthShortfall * (bandwidthFee || 0n)
  const requiredTrxSun = energyBurnSun + bandwidthBurnSun
  if (balance < requiredTrxSun) {
    throw new Error('Insufficient Mainnet resources for this deployment. Estimated Energy: ' + energy.toString()
      + '; with 20% safety margin: ' + bufferedEnergy.toString()
      + '; available Energy: ' + availableEnergy.toString()
      + '; estimated TRX needed for Energy/Bandwidth shortfall: ' + requiredTrxSun.toString()
      + ' SUN (' + (Number(requiredTrxSun) / 1e6).toFixed(6) + ' TRX); wallet balance: '
      + balance.toString() + ' SUN. No wallet signature or broadcast was attempted.')
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

export async function estimateMainnetDeploymentEnergy(tronWeb, ownerAddress, artifact) {
  if (!tronWeb?.isAddress?.(ownerAddress)) throw new Error('Enter a valid TRON Mainnet deployment owner address.')
  const bytecode = String(artifact?.bytecode || '').replace(/^0x/, '')
  if (!/^(?:[0-9a-f]{2})+$/i.test(bytecode)) throw new Error('Compiled contract init bytecode is missing or invalid.')
  const response = await postNode(tronWeb, '/wallet/triggerconstantcontract', {
    owner_address: ownerAddress,
    data: bytecode,
    visible: true,
  })
  return normalizeDeploymentEnergyEstimate(response)
}

export async function waitForSolidifiedReceipt(tronWeb, txID, { timeoutMs = 180000, intervalMs = 3000 } = {}) {
  if (!/^[0-9a-f]{64}$/i.test(String(txID || ''))) throw new Error('The wallet did not return a valid transaction ID.')
  const started = Date.now()
  let lastError = null
  while (Date.now() - started < timeoutMs) {
    try {
      const transaction = await postNode(tronWeb, '/walletsolidity/gettransactionbyid', { value: txID })
      if (transaction?.txID || transaction?.txid || transaction?.raw_data) {
        const receipt = await postNode(tronWeb, '/walletsolidity/gettransactioninfobyid', { value: txID })
        if (receipt?.id) {
          if (receipt.result === 'FAILED' || receipt.receipt?.result !== 'SUCCESS') {
            throw new Error('Solidified transaction execution failed. Transaction: ' + txID)
          }
          return receipt
        }
      }
    } catch (error) {
      if (error instanceof Error && /execution failed/.test(error.message)) throw error
      lastError = error
    }
    await new Promise((resolve) => window.setTimeout(resolve, intervalMs))
  }
  throw new Error('Transaction has not been verified in the solidified Mainnet chain. Keep its ID and check again: ' + txID + (lastError ? ' (' + lastError.message + ')' : ''))
}

export function buildDeploymentOptions(artifact, contractName, feeLimitSun) {
  const feeLimit = Number(feeLimitSun)
  if (!Number.isSafeInteger(feeLimit) || feeLimit <= 0) throw new Error('Invalid deployment fee cap. Enter a positive whole-number TRX fee cap.')
  if (!artifact || !Array.isArray(artifact.abi)) throw new Error('Compiled contract ABI is missing or invalid. Rebuild the TRӾ contract artifacts before deployment.')
  const bytecode = String(artifact.bytecode || '').replace(/^0x/, '')
  if (!bytecode || !/^[0-9a-f]+$/i.test(bytecode)) throw new Error('Compiled contract bytecode is missing or invalid. Rebuild the TRӾ contract artifacts before deployment.')
  return {
    abi: artifact.abi,
    bytecode,
    feeLimit,
    callValue: 0,
    userFeePercentage: 100,
    originEnergyLimit: 10000000,
    name: String(contractName),
  }
}

function explainTronLinkError(error, stage) {
  const raw = typeof error === 'string' ? error : (error?.message || error?.toString?.() || 'Unknown wallet error')
  if (/Confirmation declined by user|User rejected|code.?4001/i.test(raw)) return stage + ': transaction was declined in TronLink. No retry was attempted.'
  if (/Invalid transaction provided/i.test(raw)) return stage + ': TronLink rejected the unsigned deployment transaction as invalid. Check the transaction payload and wallet/network connection. Details: ' + raw
  if (/User has not unlocked wallet/i.test(raw)) return stage + ': unlock TronLink and reconnect before trying again.'
  return stage + ': ' + raw
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJsonValue(value[key])]))
  }
  return value
}

export function sameStructuredTransactionData(left, right) {
  return JSON.stringify(stableJsonValue(left)) === JSON.stringify(stableJsonValue(right))
}

export async function verifyRawDataHash(transaction) {
  const txID = String(transaction?.txID || '').toLowerCase()
  const rawDataHex = String(transaction?.raw_data_hex || '')
  if (!/^[0-9a-f]{64}$/.test(txID) || !/^(?:[0-9a-f]{2})+$/i.test(rawDataHex)) {
    throw new Error('Deployment transaction has an invalid txID or raw_data_hex encoding.')
  }
  const subtle = globalThis.crypto?.subtle
  if (!subtle || typeof subtle.digest !== 'function') {
    throw new Error('This browser cannot verify the transaction raw_data hash. Signing is blocked.')
  }
  const bytes = new Uint8Array(rawDataHex.length / 2)
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(rawDataHex.slice(index * 2, index * 2 + 2), 16)
  }
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes))
  const actual = Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('')
  if (actual !== txID) {
    throw new Error('TRON transaction ID does not match SHA-256(raw_data_hex). The payload may have changed; signing is blocked.')
  }
  return true
}

export function normalizeSignWeightResponse(response, signerAddress, tronWeb) {
  if (!response || typeof response !== 'object' || response.Error) {
    throw new Error('TRON could not validate the signed transaction permission weight.')
  }
  const verdict = response.result || {}
  const code = verdict.code
  if (code && !['ENOUGH_PERMISSION', 0, '0'].includes(code)) {
    if (code === 'NOT_ENOUGH_PERMISSION') {
      const current = String(response.current_weight ?? '0')
      const threshold = String(response.permission?.threshold ?? 'unknown')
      throw new Error('TRON permission threshold not met: collected weight ' + current + '; required threshold ' + threshold + '. No transaction was broadcast.')
    }
    throw new Error('TRON rejected the transaction signature or permission set (' + String(code) + '). No transaction was broadcast.')
  }
  let currentWeight
  let threshold
  try {
    currentWeight = BigInt(response.current_weight)
    threshold = BigInt(response.permission?.threshold)
  } catch {
    throw new Error('TRON returned incomplete signature-weight diagnostics. No transaction was broadcast.')
  }
  if (currentWeight < 0n || threshold <= 0n) {
    throw new Error('TRON returned invalid signature-weight values. No transaction was broadcast.')
  }
  const approved = Array.isArray(response.approved_list) ? response.approved_list : []
  if (!approved.some((address) => addressesEqual(tronWeb, address, signerAddress))) {
    throw new Error('The connected TronLink wallet is not among the transaction’s approved signers. No transaction was broadcast.')
  }
  if (currentWeight < threshold) {
    throw new Error('TRON permission threshold not met: collected weight ' + currentWeight + '; required threshold ' + threshold + '. No transaction was broadcast.')
  }
  return {
    currentWeight: currentWeight.toString(),
    threshold: threshold.toString(),
    approvedSigners: approved.length,
    enoughPermission: true,
  }
}

export async function getMainnetTransactionSignWeight(tronWeb, signedTransaction, signerAddress) {
  if (!signedTransaction || !Array.isArray(signedTransaction.signature) || signedTransaction.signature.length === 0) {
    throw new Error('No signed transaction was supplied for permission validation.')
  }
  const result = await postNode(tronWeb, '/wallet/getsignweight', {
    txID: signedTransaction.txID,
    raw_data: signedTransaction.raw_data,
    raw_data_hex: signedTransaction.raw_data_hex,
    signature: signedTransaction.signature,
    visible: Boolean(signedTransaction.visible),
  })
  return normalizeSignWeightResponse(result, signerAddress, tronWeb)
}

export function toWalletSignableTransaction(transaction) {
  if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) {
    throw new Error('TRON node returned a malformed deployment transaction.')
  }
  const rawData = transaction.raw_data
  if (!rawData || typeof rawData !== 'object' || !Array.isArray(rawData.contract)
    || rawData.contract.length !== 1 || rawData.contract[0]?.type !== 'CreateSmartContract') {
    throw new Error('TRON node returned an invalid CreateSmartContract signing payload.')
  }
  const txID = String(transaction.txID || '')
  const rawDataHex = String(transaction.raw_data_hex || '')
  if (!/^[0-9a-f]{64}$/i.test(txID) || !/^(?:[0-9a-f]{2})+$/i.test(rawDataHex)) {
    throw new Error('TRON node returned incomplete transaction signing fields.')
  }
  // TronLink's trx.sign accepts the protocol transaction shape only:
  // visible (optional), txID, raw_data and raw_data_hex. createSmartContract
  // also returns contract_address as UI metadata; passing that extra field
  // through to the wallet can fail its strict transaction validator.
  const signable = {
    ...(typeof transaction.visible === 'boolean' ? { visible: transaction.visible } : {}),
    txID,
    raw_data: JSON.parse(JSON.stringify(rawData)),
    raw_data_hex: rawDataHex,
  }
  return signable
}

export async function deployContractFromTronLink(wallet, artifact, contractName, feeLimitSun) {
  // Build, sign and broadcast with the same TronLink-injected TronWeb instance.
  // A separately constructed TronWeb transaction may not match the wallet's
  // current provider/account context and can be rejected by TronLink.
  const tronWeb = assertMainnetWallet(wallet)
  if (!tronWeb?.transactionBuilder?.createSmartContract
    || typeof tronWeb?.trx?.sign !== 'function'
    || typeof tronWeb?.trx?.sendRawTransaction !== 'function') {
    throw new Error('The connected TronLink provider does not expose deployment construction, signing and broadcast methods.')
  }
  const options = buildDeploymentOptions(artifact, contractName, feeLimitSun)
  let unsigned
  try {
    unsigned = await tronWeb.transactionBuilder.createSmartContract(options, wallet.address)
  } catch (error) {
    throw new Error(explainTronLinkError(error, 'Deployment transaction construction failed'))
  }
  if (!unsigned?.txID || !/^[0-9a-f]{64}$/i.test(unsigned.txID) || !unsigned?.contract_address || !unsigned?.raw_data?.contract?.length) {
    throw new Error('TRON Mainnet returned an incomplete deployment transaction. No signature or broadcast was attempted.')
  }
  const createContract = unsigned.raw_data.contract[0]
  const ownerHex = createContract?.parameter?.value?.owner_address
  let transactionOwner = ''
  try { transactionOwner = ownerHex ? tronWeb.address.fromHex(ownerHex) : '' } catch {}
  if (createContract?.type !== 'CreateSmartContract' || !transactionOwner
    || !addressesEqual(tronWeb, transactionOwner, wallet.address)) {
    throw new Error('Deployment transaction owner does not match the connected TronLink account. Reconnect the intended account and retry. No signature or broadcast was attempted.')
  }
  const predictedAddress = tronWeb.address.fromHex(unsigned.contract_address)
  if (!tronWeb.isAddress(predictedAddress)) throw new Error('TRON node returned an invalid predicted contract address. No signature or broadcast was attempted.')
  await verifyRawDataHash(unsigned)
  // Validate the plain protocol transaction, then ask the injected wallet signer.
  // TronWeb 6.5.1 returns a new signed object; broadcast that exact return value.
  const walletTransaction = toWalletSignableTransaction(unsigned)
  if (!walletTransaction.raw_data_hex || !walletTransaction.raw_data
    || !Array.isArray(walletTransaction.raw_data.contract)
    || walletTransaction.raw_data.contract.length !== 1
    || walletTransaction.raw_data.contract[0]?.type !== 'CreateSmartContract') {
    throw new Error('TRON node returned an invalid CreateSmartContract signing payload. No wallet prompt or broadcast was attempted.')
  }
  // Safety gate: this deployment path is intentionally non-broadcasting while
  // the TronLink CreateSmartContract compatibility issue is under investigation.
  // The unsigned transaction is validated above, but must not be signed or sent.
  // Remove this gate only after a separately reviewed, explicit deployment approval
  // and an end-to-end test on a non-production network.
  throw new Error('Deployment safety hold: unsigned TRON contract transaction was prepared and validated, but signing and Mainnet broadcast are disabled. No transaction was sent. Continue with offline payload diagnostics and testnet verification.')
  let signed
  try {
    signed = await tronWeb.trx.sign(walletTransaction)
  } catch (error) {
    const contract = walletTransaction.raw_data.contract[0]
    const value = contract?.parameter?.value || {}
    const newContract = value.new_contract || {}
    const diagnostic = {
      tronWebVersion: String(tronWeb.version || 'unknown'),
      transactionType: contract?.type || 'unknown',
      parameterTypeUrl: contract?.parameter?.type_url || 'missing',
      hasContractAddress: Boolean(walletTransaction.contract_address),
      hasOwnerAddress: Boolean(value.owner_address),
      hasNewContract: Boolean(value.new_contract),
      bytecodeLength: String(newContract.bytecode || '').length,
      abiEntries: Array.isArray(newContract.abi) ? newContract.abi.length : null,
      feeLimitSun: walletTransaction.raw_data.fee_limit ?? null,
      rawDataHexLength: walletTransaction.raw_data_hex.length,
    }
    throw new Error(explainTronLinkError(error, 'TronLink signing failed') + ' Payload diagnostics: ' + JSON.stringify(diagnostic))
  }
  if (!signed || !Array.isArray(signed.signature) || signed.signature.length === 0
    || signed.txID !== walletTransaction.txID
    || signed.raw_data_hex !== walletTransaction.raw_data_hex
    || !sameStructuredTransactionData(signed.raw_data, walletTransaction.raw_data)) {
    throw new Error('TronLink did not return a valid signature for the exact deployment transaction. Nothing was broadcast.')
  }
  await getMainnetTransactionSignWeight(tronWeb, signed, wallet.address)
  let broadcast
  try {
    broadcast = await tronWeb.trx.sendRawTransaction(signed)
  } catch (error) {
    throw new Error(explainTronLinkError(error, 'Deployment broadcast request failed') + ' Check TRONSCAN for transaction ' + unsigned.txID + ' before retrying.')
  }
  if (broadcast?.result !== true) {
    let detail = broadcast?.message || broadcast?.code || 'unknown node rejection'
    try { if (typeof detail === 'string' && /^[0-9a-f]+$/i.test(detail)) detail = tronWeb.toUtf8(detail) } catch {}
    throw new Error('TRON Mainnet rejected deployment broadcast: ' + detail + '. Transaction: ' + unsigned.txID)
  }
  const receipt = await waitForSolidifiedReceipt(tronWeb, unsigned.txID)
  if (receipt?.receipt?.result !== 'SUCCESS') throw new Error('Deployment transaction is not confirmed successful. Transaction: ' + unsigned.txID)
  const deployed = await tronWeb.trx.getContract(predictedAddress)
  if (!deployed?.bytecode) throw new Error('Deployment receipt succeeded, but deployed contract bytecode could not be verified. Transaction: ' + unsigned.txID)
  return { address: predictedAddress, txID: unsigned.txID, receipt }
}

export async function sendAndVerifyContractCall(tronWeb, method, feeLimitSun = 150000000) {
  const result = await method.send({
    feeLimit: feeLimitSun,
    callValue: 0,
    shouldPollResponse: false,
    keepTxID: true,
  })
  const txID = Array.isArray(result) ? result[0] : result
  if (typeof txID !== 'string' || !/^[0-9a-f]{64}$/i.test(txID)) throw new Error('TronLink did not return a valid transaction ID.')
  const receipt = await waitForSolidifiedReceipt(tronWeb, txID)
  return { txID, receipt }
}

export async function sendNativeTrxFromTronLink(wallet, toAddress, amountSun) {
  const tronWeb = assertMainnetWallet(wallet)
  if (!tronWeb.isAddress(toAddress)) throw new Error('Invalid reserve-vault TRON address.')
  const amount = BigInt(String(amountSun))
  if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid TRX funding amount.')
  const unsigned = await tronWeb.transactionBuilder.sendTrx(toAddress, Number(amount), wallet.address)
  const signed = await tronWeb.trx.sign(unsigned)
  if (!signed?.signature?.length) throw new Error('TronLink did not sign the native TRX funding transaction.')
  const broadcast = await tronWeb.trx.sendRawTransaction(signed)
  if (broadcast?.result !== true) throw new Error('TRON Mainnet rejected the TRX funding transfer.')
  const receipt = await waitForSolidifiedReceipt(tronWeb, unsigned.txID)
  return { txID: unsigned.txID, receipt }
}
