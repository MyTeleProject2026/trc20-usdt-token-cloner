import artifacts from './generated/trax-contract-artifacts.js'
import { TronWeb } from 'tronweb'

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

const CHAIN_PARAMETERS_CACHE_TTL_MS = 60000
const NODE_MIN_REQUEST_INTERVAL_MS = 400
const NODE_MAX_RETRIES_429 = 3
let chainParametersCache = { value: null, expiresAt: 0, pending: null }
let nodeRequestQueue = Promise.resolve()
let nodeNextRequestAt = 0
let nodeCooldownUntil = 0

function retryDelayMs(response, attempt, detail = '') {
  const retryAfter = response?.headers?.get?.('Retry-After')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(15000, Math.max(1250, seconds * 1000 + 250))
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) return Math.min(15000, Math.max(1250, date - Date.now() + 250))
  }
  // TronGrid's JSON error can specify a one-second suspension even when it
  // omits Retry-After. Do not retry inside that suspension window.
  const suspended = String(detail).match(/suspended\s+for\s+(\d+(?:\.\d+)?)\s*s/i)
  if (suspended) return Math.min(15000, Math.max(1250, Number(suspended[1]) * 1000 + 250))
  return Math.min(12000, 1500 * (2 ** attempt)) + Math.floor(Math.random() * 500)
}

function enqueueNodeRequest(task) {
  const queued = nodeRequestQueue.then(async () => {
    const waitMs = Math.max(nodeNextRequestAt, nodeCooldownUntil) - Date.now()
    if (waitMs > 0) await new Promise((resolve) => window.setTimeout(resolve, waitMs))
    const result = await task()
    nodeNextRequestAt = Date.now() + NODE_MIN_REQUEST_INTERVAL_MS
    if (result.response?.status === 429) {
      const cooldown = retryDelayMs(result.response, 0, result.detail)
      nodeCooldownUntil = Math.max(nodeCooldownUntil, Date.now() + cooldown)
    }
    return result
  })
  nodeRequestQueue = queued.then(() => undefined, () => undefined)
  return queued
}

async function postNode(tronWeb, path, body) {
  for (let attempt = 0; ; attempt += 1) {
    const { response, detail } = await enqueueNodeRequest(async () => {
      const response = await fetch(TRON_MAINNET_HOST + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
      })
      let detail = ''
      if (!response.ok) {
        try { detail = (await response.text()).trim().slice(0, 500) } catch {}
      }
      return { response, detail }
    })
    if (response.ok) return response.json()
    if (response.status === 429 && attempt < NODE_MAX_RETRIES_429) {
      // Re-enqueue immediately; the shared queue enforces the provider cooldown
      // once for this tab and prevents other app requests from bypassing it.
      continue
    }
    throw new Error('TRON Mainnet node returned HTTP ' + response.status + ' for ' + path
      + (detail ? ': ' + detail : '')
      + (response.status === 429 ? '. Public TronGrid rate limit reached after paced retries; the public node is still throttling this network. Wait before retrying.' : ''))
  }
}

async function getCachedChainParameters(tronWeb) {
  const now = Date.now()
  if (chainParametersCache.value && chainParametersCache.expiresAt > now) return chainParametersCache.value
  if (chainParametersCache.pending) return chainParametersCache.pending
  chainParametersCache.pending = postNode(tronWeb, '/wallet/getchainparameters', {})
    .then((value) => {
      chainParametersCache = { value, expiresAt: Date.now() + CHAIN_PARAMETERS_CACHE_TTL_MS, pending: null }
      return value
    })
    .catch((error) => {
      chainParametersCache.pending = null
      throw error
    })
  return chainParametersCache.pending
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
  // Read through the same paced public-node queue as every other preflight call.
  // TronWeb's convenience getBalance() bypasses this queue and can create an
  // extra concurrent request against the same unauthenticated 3-RPS allowance.
  const accountResources = await postNode(tronWeb, '/wallet/getaccountresource', { address, visible: true })
  const chainParameters = await getCachedChainParameters(tronWeb)
  const account = await postNode(tronWeb, '/wallet/getaccount', { address, visible: true })
  if (!account || typeof account !== 'object' || account.Error) {
    throw new Error('TRON Mainnet could not return the connected account balance.')
  }
  const nativeBalanceSun = account.balance ?? 0
  return normalizeMainnetAccountResources(accountResources, chainParameters, nativeBalanceSun)
}

export function normalizeDeploymentEnergyEstimate(response) {
  if (!response || response.Error || response.result?.result !== true) {
    const detail = response?.result?.message || response?.result?.code || response?.Error || 'Mainnet node could not simulate contract creation'
    throw new Error('TRON Mainnet deployment Energy simulation failed: ' + detail)
  }
  // TronGrid's triggerconstantcontract response for deployment simulation
  // may provide result.result + energy_used without transaction.ret. Validate
  // execution status when the node includes it, but do not require that optional
  // transaction envelope for a successful simulation response.
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
  // TRON does not combine staked/delegated Bandwidth with the free quota for
  // one transaction: either source must cover the complete byte cost.
  const freeBandwidth = BigInt(resourceSnapshot.freeBandwidthAvailable)
  const stakedBandwidth = BigInt(resourceSnapshot.stakedBandwidthAvailable)
  const availableBandwidth = freeBandwidth > stakedBandwidth ? freeBandwidth : stakedBandwidth
  const balance = BigInt(resourceSnapshot.nativeBalanceSun)
  const maxFeeLimit = resourceSnapshot.maxFeeLimitSun == null ? null : BigInt(resourceSnapshot.maxFeeLimitSun)
  if (energyFee <= 0n || balance < 0n) throw new Error('Mainnet returned invalid Energy price or TRX balance.')
  if (maxFeeLimit === null || maxFeeLimit <= 0n) {
    throw new Error('TRON Mainnet did not return getMaxFeeLimit. Cannot validate the deployment fee cap safely.')
  }
  const bufferedEnergy = (energy * BigInt(safetyMarginBps) + 9999n) / 10000n
  const requiredFeeLimit = bufferedEnergy * energyFee
  if (requiredFeeLimit > maxFeeLimit) {
    throw new Error('Estimated deployment Energy with the safety margin requires a fee cap above the current TRON Mainnet maximum. Reduce contract deployment complexity; this transaction cannot be safely budgeted.')
  }
  if (feeLimit > maxFeeLimit) {
    throw new Error('Selected fee cap exceeds the current TRON Mainnet maximum of ' + maxFeeLimit.toString() + ' SUN.')
  }
  if (feeLimit < requiredFeeLimit) {
    throw new Error('Selected fee cap is too low for the estimated deployment. Required at least ' + requiredFeeLimit.toString() + ' SUN (' + (Number(requiredFeeLimit) / 1e6).toFixed(6) + ' TRX) with the safety margin.')
  }
  const energyShortfall = bufferedEnergy > availableEnergy ? bufferedEnergy - availableEnergy : 0n
  const estimatedBandwidthBytes = BigInt(Math.ceil(rawDataHex.length / 2) + 3 + 64 + 67)
  // Resource quotas are consumed first; TRX covers the remaining Energy
  // and the full Bandwidth transaction cost when neither quota can cover it.
  const bandwidthShortfall = estimatedBandwidthBytes > availableBandwidth ? estimatedBandwidthBytes : 0n

  const energyBurnSun = energyShortfall * energyFee
  if (bandwidthShortfall > 0n && (bandwidthFee === null || bandwidthFee <= 0n)) {
    throw new Error('TRON Mainnet did not return a valid Bandwidth fee. Cannot safely estimate the TRX fallback.')
  }
  const bandwidthBurnSun = bandwidthShortfall * (bandwidthFee || 0n)
  const requiredTrxSun = energyBurnSun + bandwidthBurnSun
  if (balance < requiredTrxSun) {
    throw new Error('Insufficient TRX for the estimated Mainnet resource shortfall. Estimated fee fallback: '
      + requiredTrxSun.toString() + ' SUN (' + (Number(requiredTrxSun) / 1e6).toFixed(6)
      + ' TRX); available balance: ' + balance.toString() + ' SUN. Add TRX or obtain more Energy/Bandwidth delegation. No wallet signature or broadcast was attempted.')
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

export function decodeTronBroadcastFailure(tronWeb, broadcast, txID) {
  let detail = broadcast?.message || broadcast?.code || 'unknown node rejection'
  try {
    if (typeof detail === 'string' && /^(?:[0-9a-f]{2})+$/i.test(detail)) detail = tronWeb.toUtf8(detail)
  } catch {}
  const normalized = String(detail).toLowerCase()
  const tx = ' Transaction: ' + String(txID || 'unknown') + '.'
  if (/bandwith_error|bandwidth_error|account resource insufficient|resource insufficient|bandwidth.*(insufficient|not enough)|(insufficient|not enough).*bandwidth/.test(normalized)) {
    return 'TRON Mainnet rejected deployment before contract execution because the account cannot cover the transaction Bandwidth requirement (or its TRX fallback). Available Energy does not pay Bandwidth. Obtain enough delegated/staked Bandwidth or TRX for the Bandwidth shortfall, then retry with a fresh transaction.' + tx
  }
  if (/out_of_energy|energy.*(insufficient|not enough)|(insufficient|not enough).*energy/.test(normalized)) {
    return 'TRON Mainnet rejected deployment because the available Energy/fee budget is insufficient. Estimate deployment Energy, then obtain additional delegated/staked Energy or enough TRX to cover the Energy shortfall and set an adequate fee limit.' + tx
  }
  if (/balance is not sufficient|insufficient balance|not enough trx/.test(normalized)) {
    return 'TRON Mainnet rejected deployment because the account has insufficient TRX to cover required network fees or account costs. Add TRX or obtain the missing resources by delegation.' + tx
  }
  return 'TRON Mainnet rejected deployment broadcast: ' + String(detail) + '.' + tx
}

function explainTronLinkError(error, stage) {
  const raw = typeof error === 'string' ? error : (error?.message || error?.toString?.() || 'Unknown wallet error')
  if (/Confirmation declined by user|User rejected|code.?4001/i.test(raw)) return stage + ': transaction was declined in TronLink. No retry was attempted.'
  if (/Invalid transaction provided/i.test(raw)) return stage + ': TronLink rejected the unsigned deployment transaction as invalid. Check the transaction payload and wallet/network connection. Details: ' + raw
  if (/User has not unlocked wallet/i.test(raw)) return stage + ': unlock TronLink and reconnect before trying again.'
  return stage + ': ' + raw
}

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}

export async function sha256HexFromBytes(hex) {
  const value = String(hex || '')
  if (!/^(?:[0-9a-f]{2})+$/i.test(value)) throw new Error('Malformed raw_data_hex; refusing to sign or broadcast.')
  if (!globalThis.crypto?.subtle) throw new Error('Secure SHA-256 verification is unavailable in this browser; refusing to sign or broadcast.')
  const bytes = new Uint8Array(value.match(/../g).map(byte => Number.parseInt(byte, 16)))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
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
  if (!/^[0-9a-f]{64}$/i.test(txID) || !/^[0-9a-f]+$/i.test(rawDataHex)) {
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
    throw new Error('Deployment requires exactly one valid 65-byte TronLink signature; refusing broadcast.')
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

export const MAINNET_DEPLOYMENT_SIGNING_ENABLED = true
export const MAINNET_DEPLOYMENT_BROADCAST_ENABLED = true

export async function deployContractFromTronLink(wallet, artifact, contractName, feeLimitSun, {
  createVerifier = () => new TronWeb({ fullHost: TRON_MAINNET_HOST }),
  waitForReceipt = waitForSolidifiedReceipt,
  verifyDeployedContract = async (client, address) => client.trx.getContract(address),
  verifyDeployedOwner = async (client, artifact, address) => {
    const instance = await client.contract(artifact.abi).at(address)
    return instance.owner().call()
  },
  readResources = getMainnetAccountResourceSnapshot,
  readPermissions = getMainnetAccountPermissionSnapshot,
  estimateEnergy = estimateMainnetDeploymentEnergy,
} = {}) {
  // Use TronLink's injected Mainnet client for transaction construction, signing
  // and broadcast. Use a pinned read-only TronWeb verifier for byte-level checks,
  // permission queries, resource reads and solidified receipt verification. Never
  // build with one transaction provider and ask a different provider to sign it.
  const walletTronWeb = assertMainnetWallet(wallet)
  const tronWeb = createVerifier()
  if (!walletTronWeb?.transactionBuilder?.createSmartContract
    || typeof walletTronWeb?.trx?.sign !== 'function'
    || typeof walletTronWeb?.trx?.sendRawTransaction !== 'function'
    || !tronWeb?.utils?.transaction?.txCheck
    || !tronWeb?.utils?.crypto?.ecRecover
    || typeof tronWeb?.trx?.getSignWeight !== 'function') {
    throw new Error('The connected TronLink provider cannot build, sign and broadcast Mainnet deployments, or the pinned verifier cannot validate signatures and permissions.')
  }
  // Pace the preflight reads instead of bursting resource, permission and
  // deployment-simulation requests at the public TronGrid endpoint together.
  const resourceSnapshot = await readResources(tronWeb, wallet.address)
  const permissionSnapshot = await readPermissions(tronWeb, wallet.address)
  const energyEstimate = await estimateEnergy(tronWeb, wallet.address, artifact)
  if (!permissionSnapshot.connectedSignerCanAuthorizeAlone) {
    throw new Error('Connected wallet cannot satisfy the TRON owner permission threshold alone. Collected weight '
      + permissionSnapshot.connectedSignerWeight + '; required threshold ' + permissionSnapshot.threshold
      + '; additional signer weight required ' + permissionSnapshot.requiredAdditionalWeight
      + '. No wallet signature or broadcast was attempted.')
  }
  const options = buildDeploymentOptions(artifact, contractName, feeLimitSun)
  let unsigned
  try {
    unsigned = await walletTronWeb.transactionBuilder.createSmartContract(options, wallet.address)
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
  if (Number(unsigned.raw_data?.fee_limit) !== Number(feeLimitSun)) {
    throw new Error('Mainnet node changed the requested deployment fee_limit. No wallet signature or broadcast was attempted.')
  }
  const resourceBudget = calculateDeploymentResourceBudget({
    energyRequired: energyEstimate.energyUsed,
    resourceSnapshot,
    rawDataHex: unsigned.raw_data_hex,
    feeLimitSun,
  })
  assertTransactionIntegrity(tronWeb, unsigned, 'Unsigned deployment transaction')
  const computedUnsignedTxID = await sha256HexFromBytes(unsigned.raw_data_hex)
  if (computedUnsignedTxID.toLowerCase() !== String(unsigned.txID).toLowerCase()) {
    throw new Error('TRON node txID does not match SHA-256(raw_data_hex). Nothing was signed or broadcast.')
  }
  if (!MAINNET_DEPLOYMENT_SIGNING_ENABLED) {
    throw new Error('Mainnet deployment signing is disabled by the release configuration. No wallet signature was requested and nothing was broadcast.')
  }
  const walletTransaction = toWalletSignableTransaction(unsigned)
  if (!walletTransaction.raw_data_hex || !walletTransaction.raw_data
    || !Array.isArray(walletTransaction.raw_data.contract)
    || walletTransaction.raw_data.contract.length !== 1
    || walletTransaction.raw_data.contract[0]?.type !== 'CreateSmartContract') {
    throw new Error('TRON node returned an invalid CreateSmartContract signing payload. No wallet prompt or broadcast was attempted.')
  }
  let signed
  try {
    signed = await walletTronWeb.trx.sign(walletTransaction)
  } catch (error) {
    const contract = walletTransaction.raw_data.contract[0]
    const value = contract?.parameter?.value || {}
    const newContract = value.new_contract || {}
    const diagnostic = {
      tronWebVersion: String(tronWeb.version || 'unknown'),
      transactionType: contract?.type || 'unknown',
      parameterTypeUrl: contract?.parameter?.type_url || 'missing',
      hasOwnerAddress: Boolean(value.owner_address),
      hasNewContract: Boolean(value.new_contract),
      bytecodeLength: String(newContract.bytecode || '').length,
      abiEntries: Array.isArray(newContract.abi) ? newContract.abi.length : null,
      feeLimitSun: walletTransaction.raw_data.fee_limit ?? null,
      rawDataHexLength: walletTransaction.raw_data_hex.length,
      estimatedEnergy: resourceBudget.energyRequired,
      energyWithSafetyMargin: resourceBudget.energyWithSafetyMargin,
      estimatedTrxShortfallSun: resourceBudget.requiredTrxSun,
    }
    throw new Error(explainTronLinkError(error, 'TronLink signing failed') + ' Payload diagnostics: ' + JSON.stringify(diagnostic))
  }
  const signatures = signed?.signature
  const hasValidSignature = Array.isArray(signatures)
    && signatures.length === 1
    && typeof signatures[0] === 'string'
    && /^[0-9a-f]{130}$/i.test(signatures[0])
  const returnedRawDataHex = signed?.raw_data_hex
  const rawDataHexMatches = returnedRawDataHex == null
    || (typeof returnedRawDataHex === 'string'
      && returnedRawDataHex.toLowerCase() === walletTransaction.raw_data_hex.toLowerCase())
  if (!signed || !hasValidSignature
    || String(signed.txID || '').toLowerCase() !== walletTransaction.txID.toLowerCase()
    || !rawDataHexMatches) {
    const reason = !signed ? 'missing signed transaction'
      : !hasValidSignature ? 'missing or malformed 65-byte signature'
      : String(signed.txID || '').toLowerCase() !== walletTransaction.txID.toLowerCase() ? 'transaction ID changed'
      : 'wallet changed raw_data_hex'
    throw new Error('TronLink signing result failed cryptographic payload consistency validation (' + reason + '). Nothing was broadcast.')
  }
  // The signature is verified against the original raw_data bytes; rebuild only
  // the protocol transaction envelope so omitted Android provider fields cannot
  // change the signed payload.
  const signedTransaction = { ...walletTransaction, signature: [...signatures] }
  assertTransactionIntegrity(tronWeb, signedTransaction, 'Signed deployment transaction')
  verifyTransactionSigner(tronWeb, signedTransaction, wallet.address)
  await assertTransactionPermission(tronWeb, signedTransaction, wallet.address)
  if (!MAINNET_DEPLOYMENT_BROADCAST_ENABLED) {
    throw new Error('Mainnet deployment broadcasting is disabled. Signature was validated, but the transaction was not broadcast.')
  }
  let broadcast
  try {
    broadcast = await walletTronWeb.trx.sendRawTransaction(signedTransaction)
  } catch (error) {
    throw new Error(explainTronLinkError(error, 'Deployment broadcast request failed') + ' Check TRONSCAN for transaction ' + unsigned.txID + ' before retrying.')
  }
  if (broadcast?.result !== true) throw new Error(decodeTronBroadcastFailure(tronWeb, broadcast, unsigned.txID))
  const receipt = await waitForReceipt(tronWeb, unsigned.txID)
  if (receipt?.receipt?.result !== 'SUCCESS') throw new Error('Deployment transaction is not confirmed successful. Transaction: ' + unsigned.txID)
  const deployed = await verifyDeployedContract(tronWeb, predictedAddress)
  if (!deployed?.bytecode) throw new Error('Deployment receipt succeeded, but deployed contract bytecode could not be verified. Transaction: ' + unsigned.txID)
  let deployedOwner
  try { deployedOwner = await verifyDeployedOwner(tronWeb, artifact, predictedAddress) } catch (error) {
    throw new Error('Deployment receipt and bytecode were verified, but the deployed contract owner could not be read. Transaction: ' + unsigned.txID + '. ' + (error?.message || String(error)))
  }
  if (!addressesEqual(tronWeb, deployedOwner, wallet.address)) {
    throw new Error('Deployment receipt succeeded, but on-chain owner() does not match the TronLink deployer. Expected ' + wallet.address + '; received ' + deployedOwner + '. Transaction: ' + unsigned.txID)
  }
  return { address: predictedAddress, txID: unsigned.txID, receipt, resourceBudget, owner: deployedOwner }
}

export async function sendAndVerifyContractCall(tronWeb, method, feeLimitSun = 150000000, ownerAddress = '') {
  if (typeof ownerAddress !== 'string' || !tronWeb?.isAddress?.(ownerAddress)) {
    throw new Error('Free-delegation contract calls require the connected Mainnet owner address.')
  }
  const account = await postNode(tronWeb, '/wallet/getaccount', { address: ownerAddress, visible: true })
  if (!account || typeof account !== 'object' || account.Error) {
    throw new Error('Could not verify the Mainnet wallet balance. Refusing contract call.')
  }
  let nativeBalance
  try { nativeBalance = BigInt(account.balance ?? 0) } catch {
    throw new Error('Mainnet wallet returned an invalid native TRX balance. Refusing contract call.')
  }
  if (nativeBalance !== 0n) {
    throw new Error('Free-delegation no-burn mode requires a zero native TRX balance before contract calls. This prevents TRX-burn fallback if resource availability changes before confirmation. No transaction was sent.')
  }
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
