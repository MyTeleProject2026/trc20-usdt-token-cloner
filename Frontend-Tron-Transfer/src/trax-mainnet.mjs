import artifacts from './generated/trax-contract-artifacts.js'
import { TronWeb } from 'tronweb'
import {
  assertTransactionIntegrity,
  verifyTransactionSigner,
  assertTransactionPermission,
} from './tron-mainnet-preflight.mjs'
export {
  assertTransactionIntegrity,
  verifyTransactionSigner,
  assertTransactionPermission,
} from './tron-mainnet-preflight.mjs'
import {
  decodeNodeErrorText,
  normalizeMainnetAccountResources,
  normalizeMainnetPermissionSnapshot,
  normalizeDeploymentEnergyEstimate,
  calculateDeploymentResourceBudget,
  isMainnetEnergyEstimateUnavailable,
  assertZeroTrxBurnBudget,
  estimateMainnetContractCallEnergy as estimateMainnetContractCallEnergyShared,
} from './tron-mainnet-preflight.mjs'
export {
  normalizeMainnetAccountResources,
  normalizeMainnetPermissionSnapshot,
  normalizeDeploymentEnergyEstimate,
  calculateDeploymentResourceBudget,
  isMainnetEnergyEstimateUnavailable,
  assertZeroTrxBurnBudget,
} from './tron-mainnet-preflight.mjs'

export const TRON_MAINNET_HOST = 'https://api.trongrid.io'
export const TRAX_STORAGE_KEY = 'tron-transfer:trax-mainnet-contracts:v1'
export const TRAX_TOKEN_ARTIFACT = artifacts.token

// A provider's non-retryable one-time promo rejection is stable for this page session.
// Cache only the eligibility result; never store a signature, nonce, or provider ticket.
const TENERGY_INELIGIBLE_OWNER_ADDRESSES = new WeakMap()

function hasCachedTenergyIneligibility(fetchImpl, address) {
  return Boolean(TENERGY_INELIGIBLE_OWNER_ADDRESSES.get(fetchImpl)?.has(address))
}

function cacheTenergyIneligibility(fetchImpl, address) {
  let addresses = TENERGY_INELIGIBLE_OWNER_ADDRESSES.get(fetchImpl)
  if (!addresses) {
    addresses = new Set()
    TENERGY_INELIGIBLE_OWNER_ADDRESSES.set(fetchImpl, addresses)
  }
  addresses.add(address)
}

const TENERGY_PROMO_API_BASE = String(
  import.meta.env?.VITE_RESOURCE_API_BASE_URL
  || 'https://tron-transfer-resource-api.onrender.com',
).replace(/\/+$/, '')

async function tenergyPromoRequest(path, { method = 'GET', body, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(TENERGY_PROMO_API_BASE + '/api/tron/tenergy/promo' + path, {
    method,
    headers: body === undefined ? { accept: 'application/json' } : {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  })
  let payload = null
  try { payload = await response.json() } catch {}
  return { response, payload }
}

/**
 * Attempts the eligible, one-time TEnergy promotional Energy grant.
 * The claim itself is a TIP-191 message signature, not an on-chain transaction.
 * The provider grant is accepted only after the provider reports delegation and
 * a fresh Mainnet resource snapshot shows EnergyLimit increased. This grant
 * never covers Bandwidth and never bypasses the normal deployment zero-burn gate.
 */
export async function claimTenergyPromoForDeployment(wallet, ownerAddress, {
  onStage = () => {},
  fetchImpl = fetch,
  pollAttempts = 20,
  pollIntervalMs = 3000,
  readResources = getMainnetAccountResourceSnapshot,
} = {}) {
  const tronWeb = assertMainnetWallet(wallet)
  if (!addressesEqual(tronWeb, wallet.address, ownerAddress)) {
    throw new Error('TEnergy promo claim is restricted to the connected TRӾ owner wallet.')
  }

  const promoOwnerKey = String(ownerAddress).toLowerCase()
  if (hasCachedTenergyIneligibility(fetchImpl, promoOwnerKey)) {
    return {
      status: 'promo-not-eligible',
      providerCode: '3038',
      retryable: false,
      energyVerified: false,
      message: 'TEnergy previously confirmed that this owner address was not included in the one-time promotional distribution. The provider marks this result non-retryable; no new claim or wallet signature was attempted.',
    }
  }

  const getStatus = async () => {
    const { response, payload } = await tenergyPromoRequest(
      '/status?address=' + encodeURIComponent(ownerAddress),
      { fetchImpl },
    )
    if (!response.ok || payload?.success !== true) return null
    return payload
  }

  let initialResources
  try {
    onStage('Checking owner resources before any promotional claim')
    initialResources = await readResources(tronWeb, ownerAddress)
  } catch {
    return { status: 'resource-snapshot-unavailable', energyVerified: false, message: 'Could not establish a pre-claim Mainnet resource baseline. The promotional claim was not attempted.' }
  }

  let status
  try {
    onStage('Checking TEnergy one-time Mainnet promotion eligibility')
    status = await getStatus()
  } catch {
    return { status: 'provider-unavailable', energyVerified: false, message: 'TEnergy promotion status could not be checked. Continuing to the normal deployment resource gate.' }
  }
  if (!status) {
    return { status: 'provider-unavailable', energyVerified: false, message: 'TEnergy promotion status is unavailable. Continuing to the normal deployment resource gate.' }
  }

  const readActiveInboundEnergyDelegation = async () => {
    try {
      const response = await fetchImpl(TENERGY_PROMO_API_BASE + '/api/tron/resources/free-delegation/status?address='
        + encodeURIComponent(ownerAddress) + '&refresh=1', {
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
      })
      const payload = await response.json()
      if (!response.ok || payload?.success !== true) return false
      const now = Date.now()
      return (payload.inboundDelegations?.records || []).some((record) => {
        const amount = BigInt(String(record?.energyStakeSun || '0'))
        const expiry = Number(record?.energyExpireTime || 0)
        return amount > 0n && (expiry === 0 || expiry > now)
      })
    } catch {
      return false
    }
  }

  if (status.redemption?.status === 'delegated') {
    const [current, inboundEnergyDelegation] = await Promise.all([
      readResources(tronWeb, ownerAddress),
      readActiveInboundEnergyDelegation(),
    ])
    return {
      status: 'already-redeemed',
      energyVerified: inboundEnergyDelegation && BigInt(current.energyAvailable) > 0n,
      energyAvailable: current.energyAvailable,
      bandwidthCovered: false,
      message: 'TEnergy reports this wallet has already claimed its one-time Energy grant. A fresh Mainnet read checks for active inbound Energy; the deployment preflight independently verifies the exact required amount.',
    }
  }
  if (status.redemption?.status === 'failed') {
    return { status: 'previous-claim-failed', energyVerified: false, message: 'TEnergy records a failed one-time claim for this wallet. It cannot be claimed again through this promo.' }
  }
  if (status.redemption?.status === 'granting') {
    onStage('Resuming the existing TEnergy Energy delegation check; no second claim or signature will be requested')
    for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => globalThis.setTimeout(resolve, pollIntervalMs))
      let next
      try { next = await getStatus() } catch {}
      const redemption = next?.redemption
      if (redemption?.status === 'failed') {
        return { status: 'grant-failed', energyVerified: false, message: 'TEnergy reports that the existing promotional claim failed. The one-time grant cannot be repeated.' }
      }
      if (redemption?.status === 'delegated') {
        const [freshResources, inboundEnergyDelegation] = await Promise.all([
          readResources(tronWeb, ownerAddress),
          readActiveInboundEnergyDelegation(),
        ])
        const resourceIncrease = BigInt(freshResources.energyLimit) - BigInt(initialResources.energyLimit)
        if (inboundEnergyDelegation && resourceIncrease > 0n
          && BigInt(freshResources.energyAvailable) > BigInt(initialResources.energyAvailable)) {
          return {
            status: 'delegated-and-chain-verified',
            energyVerified: true,
            energyIncrease: resourceIncrease.toString(),
            energyAvailable: freshResources.energyAvailable,
            bandwidthCovered: false,
            message: 'The previously accepted TEnergy grant is now visible in a fresh Mainnet resource snapshot and active inbound delegation.',
          }
        }
      }
    }
    const pendingResources = await readResources(tronWeb, ownerAddress).catch(() => null)
    return {
      status: 'grant-pending',
      energyVerified: false,
      energyAvailable: pendingResources?.energyAvailable || '0',
      bandwidthCovered: false,
      message: 'The existing TEnergy one-time claim is still pending or its delegation is not yet visible on Mainnet. No second claim was created; the normal deployment gate will check current resources.',
    }
  }
  if (status.promo?.state !== 'active' || status.promo?.grant?.resource !== 'energy') {
    return {
      status: 'promo-not-active',
      energyVerified: false,
      promoState: status.promo?.state || 'unknown',
      message: 'No active TEnergy promotional Energy grant is currently available. Continuing to the normal deployment resource gate.',
    }
  }

  let challenge
  try {
    onStage('Checking whether the owner address is eligible for the one-time Energy grant')
    const result = await tenergyPromoRequest('/challenge', {
      method: 'POST',
      body: { address: ownerAddress },
      fetchImpl,
    })
    challenge = result.payload
    if (!result.response.ok || challenge?.success !== true) {
      const providerError = challenge?.error ?? challenge?.error_code ?? challenge?.code ?? null
      const providerSlug = String(challenge?.slug || '').toLowerCase()
      const permanentIneligibility = Number(providerError) === 3038
        || providerSlug === 'promo_not_eligible'
        || String(providerError || '').toUpperCase() === 'PROMO_NOT_ELIGIBLE'
        || challenge?.status === 'promo-not-eligible'
      if (permanentIneligibility || challenge?.retryable === false) {
        if (permanentIneligibility) cacheTenergyIneligibility(fetchImpl, promoOwnerKey)
        return {
          status: permanentIneligibility ? 'promo-not-eligible' : (challenge?.status || 'promo-claim-rejected'),
          providerCode: providerError === null ? null : String(providerError),
          providerSlug: providerSlug || null,
          retryable: false,
          energyVerified: false,
          message: permanentIneligibility
            ? 'TEnergy confirms this owner address was not included in the one-time promotional distribution (provider code 3038). No wallet signature or claim redemption was requested. The normal zero-TRX deployment resource check remains in force.'
            : (challenge?.message || 'The promotional provider rejected this claim and marked it non-retryable. No wallet signature or redemption was requested.'),
        }
      }
      return {
        status: challenge?.status || 'challenge-unavailable',
        providerCode: providerError === null ? null : String(providerError),
        retryable: challenge?.retryable !== false,
        energyVerified: false,
        message: challenge?.message || 'The owner wallet is not eligible for this promotion. Continuing to the normal deployment resource gate.',
      }
    }
  } catch {
    return { status: 'challenge-unavailable', energyVerified: false, message: 'TEnergy eligibility could not be confirmed. No wallet message was signed.' }
  }

  const signer = wallet?.tronWeb?.trx?.signMessageV2
  if (typeof signer !== 'function') {
    return { status: 'wallet-message-signing-unavailable', energyVerified: false, message: 'The local Owner signer does not expose signMessageV2. No claim was submitted.' }
  }

  let signature
  try {
    onStage('Requesting the owner wallet signature for the fee-free promotional claim message')
    signature = await signer.call(wallet.tronWeb.trx, challenge.message)
  } catch (error) {
    const code = Number(error?.code)
    if (code === 4001 || /rejected|declined|cancel/i.test(String(error?.message || ''))) {
      return { status: 'claim-signature-declined', energyVerified: false, message: 'The promotional message signature was declined. No TRON transaction was sent; normal deployment preflight will still run.' }
    }
    return { status: 'claim-signature-failed', energyVerified: false, message: 'The local Owner signer could not sign the promotional message. No TRON transaction was sent.' }
  }
  const normalizedSignature = String(signature || '').replace(/^0x/i, '')
  if (!/^[0-9a-f]{130}$/i.test(normalizedSignature)) {
    return { status: 'invalid-wallet-signature', energyVerified: false, message: 'The local Owner signer returned an invalid promotional message signature. No claim was submitted.' }
  }

  let redemption
  try {
    onStage('Submitting the signed promotional claim to TEnergy')
    const result = await tenergyPromoRequest('/redeem', {
      method: 'POST',
      body: { address: ownerAddress, nonce: challenge.nonce, signature: normalizedSignature },
      fetchImpl,
    })
    redemption = result.payload
    if (!result.response.ok || redemption?.success !== true) {
      return {
        status: redemption?.status || 'redemption-rejected',
        energyVerified: false,
        message: redemption?.message || 'TEnergy rejected the promotional claim. No deployment transaction was sent.',
      }
    }
  } catch {
    return { status: 'redemption-outcome-unknown', energyVerified: false, message: 'The TEnergy claim response was unavailable. Check the provider redemption status before attempting another claim.' }
  }

  for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
    const providerState = redemption.redemption?.status
    if (providerState === 'failed') {
      return { status: 'grant-failed', energyVerified: false, message: 'TEnergy accepted the claim but could not delegate Energy. No deployment transaction was sent by the claim step.' }
    }
    if (providerState === 'delegated') {
      const [freshResources, inboundEnergyDelegation] = await Promise.all([
        readResources(tronWeb, ownerAddress),
        readActiveInboundEnergyDelegation(),
      ])
      const resourceIncrease = BigInt(freshResources.energyLimit) - BigInt(initialResources.energyLimit)
      if (inboundEnergyDelegation && resourceIncrease > 0n
        && BigInt(freshResources.energyAvailable) > BigInt(initialResources.energyAvailable)) {
        return {
          status: 'delegated-and-chain-verified',
          energyVerified: true,
          energyIncrease: resourceIncrease.toString(),
          energyAvailable: freshResources.energyAvailable,
          bandwidthCovered: false,
          message: 'The TEnergy Energy grant is reflected in a fresh Mainnet resource snapshot and an active inbound Energy delegation. Bandwidth remains independently unverified.',
        }
      }
      // A provider status is not chain evidence. Keep polling the resource read
      // instead of treating the provider's "delegated" flag as sufficient.
    }
    if (attempt + 1 < pollAttempts) {
      onStage('Waiting for the provider delegation and rechecking Mainnet Energy (' + (attempt + 1) + '/' + pollAttempts + ')')
      await new Promise((resolve) => globalThis.setTimeout(resolve, pollIntervalMs))
      try {
        const next = await getStatus()
        if (next?.redemption) redemption = { ...redemption, redemption: next.redemption }
      } catch {}
    }
  }

  const finalResources = await readResources(tronWeb, ownerAddress).catch(() => null)
  return {
    status: redemption.redemption?.status === 'granting' ? 'grant-pending' : 'delegation-not-verified',
    energyVerified: false,
    energyAvailable: finalResources?.energyAvailable || '0',
    bandwidthCovered: false,
    message: 'The provider has not yet been independently confirmed by a fresh Mainnet Energy resource increase. The existing deployment preflight remains the final zero-burn gate.',
  }
}

export async function verifyTRAXTokenContract(tronWeb, address) {
  if (!tronWeb?.isAddress?.(address)) throw new Error('Enter a valid TRON Mainnet TRӾ contract address.')
  const expectedCode = String(TRAX_TOKEN_ARTIFACT.deployedBytecode || '').replace(/^0x/, '').toLowerCase()
  if (!/^(?:[0-9a-f]{2})+$/i.test(expectedCode)) {
    throw new Error('Compiled TRӾ runtime bytecode is missing. Rebuild the frontend artifact before using this contract.')
  }
  const info = await postNode(tronWeb, '/wallet/getcontractinfo', { value: address, visible: true })
  const deployedCode = String(info?.runtimecode || '').replace(/^0x/, '').toLowerCase()
  if (!deployedCode || deployedCode !== expectedCode) {
    throw new Error('The saved address does not contain the exact TRӾ contract bytecode compiled for this release. Refusing to issue credits or transfer tokens.')
  }
  const token = await tronWeb.contract(TRAX_TOKEN_ARTIFACT.abi).at(address)
  const [name, symbol, decimals] = await Promise.all([
    callMainnetView(token.name()),
    callMainnetView(token.symbol()),
    callMainnetView(token.decimals()),
  ])
  if (String(name) !== 'TRӾ' || String(symbol) !== 'TRӾ' || Number(decimals) !== 6) {
    throw new Error('TRӾ contract metadata mismatch. Expected TRӾ / TRӾ / 6 decimals.')
  }
  return token
}

export function assertMainnetWallet(wallet) {
  if (!wallet?.tronWeb || !wallet?.address) throw new Error('Unlock the configured Owner Wallet first.')
  if (wallet.signerType !== 'encrypted-local-owner-vault' || wallet.provider !== null) {
    throw new Error('TRON TRANSFER requires its encrypted local Owner Wallet signer. External wallet providers are not supported.')
  }
  let host = ''
  try { host = new URL(String(wallet.tronWeb.fullNode?.host || '')).hostname.toLowerCase() } catch {}
  if (host !== 'api.trongrid.io') throw new Error('Wrong network. The local Owner Wallet signer must use TRON Mainnet.')
  if (!wallet.tronWeb.isAddress(wallet.address)) throw new Error('Owner Wallet returned an invalid TRON address.')
  const signerAddress = wallet.tronWeb.defaultAddress?.base58 || wallet.tronWeb.defaultAddress?.hex || ''
  if (!signerAddress || !addressesEqual(wallet.tronWeb, signerAddress, wallet.address)) {
    throw new Error('The encrypted local Owner signer address does not match the saved Owner account.')
  }
  if (typeof wallet.tronWeb.trx?.sign !== 'function' || typeof wallet.tronWeb.trx?.sendRawTransaction !== 'function') {
    throw new Error('The encrypted local Owner Wallet cannot sign and broadcast TRON Mainnet transactions.')
  }
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
    return { tokenAddress: typeof value.tokenAddress === 'string' ? value.tokenAddress : '' }
  } catch { return { tokenAddress: '' } }
}

export function saveContractAddresses({ tokenAddress }) {
  window.localStorage.setItem(TRAX_STORAGE_KEY, JSON.stringify({
    tokenAddress: String(tokenAddress || ''),
  }))
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
    if (waitMs > 0) await new Promise((resolve) => globalThis.setTimeout(resolve, waitMs))
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

export async function callMainnetView(method) {
  if (!method || typeof method.call !== 'function') {
    throw new Error('The requested Mainnet contract read is unavailable.')
  }
  for (let attempt = 0; attempt <= NODE_MAX_RETRIES_429; attempt += 1) {
    const result = await enqueueNodeRequest(async () => {
      try {
        return { value: await method.call() }
      } catch (error) {
        const status = Number(error?.response?.status || error?.status || error?.statusCode)
        const detail = String(error?.message || error || '')
          + ' ' + String(error?.response?.data?.Error || error?.response?.data?.message || '')
        const rateLimited = status === 429 || /(?:HTTP\s*429|status code 429|rate limit|request rate exceeded|too many requests)/i.test(detail)
        if (rateLimited) {
          const cooldown = retryDelayMs(error?.response, attempt, detail)
          nodeCooldownUntil = Math.max(nodeCooldownUntil, Date.now() + cooldown)
        }
        return { error, rateLimited }
      }
    })
    if (!result.error) return result.value
    if (!result.rateLimited || attempt === NODE_MAX_RETRIES_429) throw result.error
  }
  throw new Error('TRON Mainnet contract read failed after bounded rate-limit retries.')
}

export function parseBatchCreditRows(input, isAddress, maxEntries = 50) {
  if (typeof isAddress !== 'function') throw new Error('A TRON address validator is required.')
  const rows = String(input ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (rows.length === 0 || rows.length > maxEntries) {
    throw new Error('Enter between 1 and ' + maxEntries + ' recipient,amount rows.')
  }
  const recipients = []
  const amounts = []
  for (const [index, row] of rows.entries()) {
    const parts = row.split(',').map(value => value.trim())
    if (parts.length !== 2 || !isAddress(parts[0])) {
      throw new Error('Invalid recipient row ' + (index + 1) + '. Use TRON_ADDRESS,AMOUNT.')
    }
    recipients.push(parts[0])
    amounts.push(parseTokenUnits(parts[1]))
  }
  return { recipients, amounts }
}

export async function getMainnetNativeBalance(tronWeb, address) {
  if (!tronWeb?.isAddress?.(address)) throw new Error('Enter a valid TRON Mainnet account address.')
  const account = await postNode(tronWeb, '/wallet/getaccount', { address, visible: true })
  if (!account || typeof account !== 'object' || account.Error) {
    throw new Error('TRON Mainnet could not return the requested native TRX balance.')
  }
  const balance = String(account.balance ?? '0')
  if (!/^(?:0|[1-9][0-9]*)$/.test(balance)) {
    throw new Error('TRON Mainnet returned an invalid native TRX balance.')
  }
  return balance
}

async function postNode(tronWeb, path, body) {
  for (let attempt = 0; ; attempt += 1) {
    const { response, detail } = await enqueueNodeRequest(async () => {
      const rpcHost = String(tronWeb?.fullNode?.host || TRON_MAINNET_HOST).replace(/\\/+$/, '')
      const response = await fetch(rpcHost + path, {
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

export async function createMainnetDeploymentTransaction(tronWeb, options, ownerAddress) {
  if (!tronWeb?.isAddress?.(ownerAddress)) {
    throw new Error('A valid connected TRON Mainnet owner address is required to construct the deployment transaction.')
  }
  const abi = typeof options?.abi === 'string' ? options.abi : JSON.stringify(options?.abi || [])
  let parsedAbi
  try { parsedAbi = JSON.parse(abi) } catch {
    throw new Error('Compiled TRӾ ABI is not valid JSON; refusing to construct a deployment transaction.')
  }
  if (!Array.isArray(parsedAbi)) throw new Error('Compiled TRӾ ABI must be a JSON array.')
  const bytecode = String(options?.bytecode || '').replace(/^0x/, '')
  if (!/^(?:[0-9a-f]{2})+$/i.test(bytecode)) throw new Error('Compiled TRӾ creation bytecode is malformed.')
  const feeLimit = Number(options?.feeLimit)
  if (!Number.isSafeInteger(feeLimit) || feeLimit <= 0) throw new Error('A positive whole-number fee_limit in SUN is required.')

  // Ask java-tron to create the canonical unsigned CreateSmartContract
  // transaction. Do not locally encode protobuf using a browser TronWeb build:
  // external wallet may use another protobuf implementation and reject that object.
  // This endpoint never signs or broadcasts; the returned transaction is passed
  // unchanged to the user's connected wallet for explicit approval.
  const request = {
    owner_address: tronWeb.address.toHex(ownerAddress),
    abi,
    bytecode,
    fee_limit: feeLimit,
    origin_energy_limit: Number(options.originEnergyLimit ?? 10000000),
    name: String(options.name || 'TRӾ'),
    call_value: Number(options.callValue ?? 0),
    consume_user_resource_percent: Number(options.userFeePercentage ?? 100),
    visible: false,
  }
  const response = await postNode(tronWeb, '/wallet/deploycontract', request)
  if (response?.Error || response?.result?.result === false) {
    const detail = response?.result?.message || response?.result?.code || response?.Error || 'node rejected deployment construction'
    throw new Error('TRON Mainnet wallet/deploycontract rejected the request: ' + String(detail))
  }
  // Keep the protocol transaction exactly as returned. Predicted address is derived separately.
  const transaction = response?.transaction?.raw_data ? response.transaction : response
  const contract = transaction?.raw_data?.contract?.[0]
  const value = contract?.parameter?.value
  const newContract = value?.new_contract
  const expectedOwner = tronWeb.address.toHex(ownerAddress).toLowerCase()
  if (!transaction?.txID || !/^[0-9a-f]{64}$/i.test(transaction.txID)
    || !transaction?.raw_data_hex || !/^(?:[0-9a-f]{2})+$/i.test(transaction.raw_data_hex)
    || contract?.type !== 'CreateSmartContract'
    || contract?.parameter?.type_url !== 'type.googleapis.com/protocol.CreateSmartContract'
    || String(value?.owner_address || '').toLowerCase() !== expectedOwner
    || !newContract || String(newContract.bytecode || '').replace(/^0x/, '').toLowerCase() !== bytecode.toLowerCase()
    || !Array.isArray(newContract.abi?.entrys)
    || newContract.abi.entrys.length !== parsedAbi.length) {
    throw new Error('TRON Mainnet returned an incomplete or mismatched CreateSmartContract transaction from wallet/deploycontract. No wallet signature or broadcast was attempted.')
  }
  return transaction
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
  return normalizeMainnetAccountResources(accountResources, chainParameters)
}

export async function estimateMainnetDeploymentEnergy(tronWeb, ownerAddress, artifact) {
  if (!tronWeb?.isAddress?.(ownerAddress)) throw new Error('Enter a valid TRON Mainnet deployment owner address.')
  const bytecode = String(artifact?.bytecode || '').replace(/^0x/, '')
  if (!/^(?:[0-9a-f]{2})+$/i.test(bytecode)) throw new Error('Compiled contract init bytecode is missing or invalid.')

  const request = {
    owner_address: tronWeb.address.toHex(ownerAddress),
    data: bytecode,
    call_value: 0,
    visible: false,
  }
  try {
    // Prefer the dedicated deployment estimator when the selected node exposes it.
    const response = await postNode(tronWeb, '/wallet/estimateenergy', request)
    return normalizeDeploymentEnergyEstimate(response)
  } catch (error) {
    if (!isMainnetEnergyEstimateUnavailable(error)) throw error
    // TRON's official FeeLimit documentation also supports the universal
    // triggerconstantcontract simulation for contract creation by passing
    // the compiled init bytecode in data. This is a read-only simulation:
    // it neither signs nor broadcasts a CreateSmartContract transaction.
    const response = await postNode(tronWeb, '/wallet/triggerconstantcontract', request)
    return normalizeDeploymentEnergyEstimate(response)
  }
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
    await new Promise((resolve) => globalThis.setTimeout(resolve, intervalMs))
  }
  throw new Error('Transaction has not been verified in the solidified Mainnet chain. Keep its ID and check again: ' + txID + (lastError ? ' (' + lastError.message + ')' : ''))
}

/**
 * Validates the transaction itself from a solidified node, not only its receipt.
 * The deployment tx must be the expected CreateSmartContract, initiated by the
 * intended owner, with exactly the compiled creation bytecode and ABI.
 */
export async function verifySolidifiedDeploymentTransaction(tronWeb, {
  txID, ownerAddress, artifact,
}, {
  fetchSolidifiedTransaction = async (client, id) => postNode(client, '/walletsolidity/gettransactionbyid', { value: id }),
} = {}) {
  if (!/^[0-9a-f]{64}$/i.test(String(txID || '')) || !tronWeb?.isAddress?.(ownerAddress)
    || !/^(?:[0-9a-f]{2})+$/i.test(String(artifact?.bytecode || '').replace(/^0x/, ''))) {
    throw new Error('Solidified deployment transaction verification requires a valid txID, owner, and compiled creation bytecode.')
  }
  const transaction = await fetchSolidifiedTransaction(tronWeb, txID)
  if (String(transaction?.txID || transaction?.txid || '').toLowerCase() !== txID.toLowerCase()) {
    throw new Error('The requested deployment transaction was not found by ID in solidified Mainnet.')
  }
  const contracts = transaction?.raw_data?.contract
  if (!Array.isArray(contracts) || contracts.length !== 1 || contracts[0]?.type !== 'CreateSmartContract'
    || contracts[0]?.parameter?.type_url !== 'type.googleapis.com/protocol.CreateSmartContract') {
    throw new Error('Solidified transaction is not exactly one TRON CreateSmartContract operation.')
  }
  const value = contracts[0]?.parameter?.value || {}
  let transactionOwner = ''
  try { transactionOwner = tronWeb.address.fromHex(String(value.owner_address || '')) } catch {}
  if (!transactionOwner || !addressesEqual(tronWeb, transactionOwner, ownerAddress)) {
    throw new Error('Solidified deployment transaction owner does not match the configured Owner Wallet.')
  }
  const newContract = value.new_contract || {}
  const expectedBytecode = String(artifact.bytecode).replace(/^0x/, '').toLowerCase()
  const actualBytecode = String(newContract.bytecode || '').replace(/^0x/, '').toLowerCase()
  if (!actualBytecode || actualBytecode !== expectedBytecode) {
    throw new Error('Solidified deployment transaction creation bytecode does not match the approved TRӾ artifact.')
  }
  const expectedAbi = JSON.stringify(artifact.abi)
  const actualEntries = newContract.abi?.entrys
  if (!Array.isArray(actualEntries) || JSON.stringify(actualEntries) !== expectedAbi) {
    throw new Error('Solidified deployment transaction ABI does not match the approved TRӾ artifact.')
  }
  return { txID, owner: transactionOwner, contractType: contracts[0].type, bytecodeVerified: true, abiVerified: true }
}

/**
 * Independently verifies an already-broadcast CreateSmartContract transaction.
 * This is also the recovery path when a wallet broadcast response times out:
 * callers can re-check the known txID without creating or signing another deployment.
 */
export async function verifyExistingMainnetDeployment(tronWeb, {
  txID, ownerAddress, artifact, contractAddress,
}, {
  waitForReceipt = waitForSolidifiedReceipt,
  verifySolidifiedTransaction = verifySolidifiedDeploymentTransaction,
  verifyDeployedContract = async (client, address) => client.trx.getContractInfo(address),
  verifyDeployedOwner = async (client, compiledArtifact, address) => {
    const instance = await client.contract(compiledArtifact.abi).at(address)
    return instance.owner().call()
  },
} = {}) {
  if (!/^[0-9a-f]{64}$/i.test(String(txID || ''))
    || !tronWeb?.isAddress?.(ownerAddress)
    || !tronWeb?.isAddress?.(contractAddress)
    || !/^(?:[0-9a-f]{2})+$/i.test(String(artifact?.deployedBytecode || '').replace(/^0x/, ''))) {
    throw new Error('Deployment recovery requires a valid Mainnet transaction ID, owner, contract address, and compiled runtime artifact.')
  }
  const receipt = await waitForReceipt(tronWeb, txID)
  if (receipt?.id?.toLowerCase() !== txID.toLowerCase() || receipt?.receipt?.result !== 'SUCCESS') {
    throw new Error('The supplied deployment transaction is not confirmed successful in solidified Mainnet state.')
  }
  const solidifiedTransaction = await verifySolidifiedTransaction(tronWeb, { txID, ownerAddress, artifact })
  const deployed = await verifyDeployedContract(tronWeb, contractAddress)
  const expectedRuntimeCode = String(artifact.deployedBytecode).replace(/^0x/, '').toLowerCase()
  const deployedRuntimeCode = String(deployed && deployed.runtimecode || '').replace(/^0x/, '').toLowerCase()
  if (!deployedRuntimeCode || deployedRuntimeCode !== expectedRuntimeCode) {
    throw new Error('The recovered deployment address does not contain the exact compiled TRӾ runtime bytecode.')
  }
  const deployedOwner = await verifyDeployedOwner(tronWeb, artifact, contractAddress)
  if (!addressesEqual(tronWeb, deployedOwner, ownerAddress)) {
    throw new Error('Recovered contract owner does not match the configured TRӾ owner wallet.')
  }
  const token = await tronWeb.contract(artifact.abi).at(contractAddress)
  const [name, symbol, decimals] = await Promise.all([
    callMainnetView(token.name()), callMainnetView(token.symbol()), callMainnetView(token.decimals()),
  ])
  if (String(name) !== 'TRӾ' || String(symbol) !== 'TRӾ' || Number(decimals) !== 6) {
    throw new Error('Recovered deployment metadata mismatch. Expected TRӾ / TRӾ / 6 decimals.')
  }
  return { address: contractAddress, txID, receipt, solidifiedTransaction, owner: deployedOwner, verified: true, network: 'mainnet' }
}

/**
 * Recovery helper for a broadcast whose HTTP response was lost or timed out.
 * It derives the contract address from the original txID and never rebroadcasts.
 */
export async function recoverMainnetDeployment(tronWeb, {
  txID, ownerAddress, artifact,
}, dependencies = {}) {
  const contractAddress = predictMainnetContractAddress(tronWeb, ownerAddress, txID)
  return verifyExistingMainnetDeployment(tronWeb, {
    txID, ownerAddress, artifact, contractAddress,
  }, dependencies)
}

export function buildDeploymentOptions(artifact, contractName, feeLimitSun) {
  const feeLimit = Number(feeLimitSun)
  if (!Number.isSafeInteger(feeLimit) || feeLimit <= 0) throw new Error('Invalid deployment fee cap. Enter a positive whole-number TRX fee cap.')
  if (!artifact || !Array.isArray(artifact.abi)) throw new Error('Compiled contract ABI is missing or invalid. Rebuild the TRӾ contract artifacts before deployment.')
  const bytecode = String(artifact.bytecode || '').replace(/^0x/, '')
  if (!bytecode || !/^[0-9a-f]+$/i.test(bytecode)) throw new Error('Compiled contract bytecode is missing or invalid. Rebuild the TRӾ contract artifacts before deployment.')
  return {
    // TronWeb transactionBuilder.createSmartContract expects ABI as JSON text.
    // Passing the compiler's raw ABI array can produce a CreateSmartContract
    // payload that external wallet rejects as 'Invalid transaction provided'.
    abi: JSON.stringify(artifact.abi),
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

export function formatOwnerWalletError(error, stage = 'TRON operation failed') {
  // Preserve enumerable and non-enumerable provider fields. Axios/external wallet
  // frequently wrap JSON details inside Error instances whose JSON.stringify()
  // output is empty and whose .message alone loses provider code/status values.
  const details = {}
  const sources = [
    error?.response?.data,    error?.data,
    error,
    error?.cause,
    error?.error,
  ]
  const fields = ['name', 'message', 'code', 'slug', 'status', 'statusCode', 'field', 'retryable', 'Error']
  for (const source of sources) {
    if (typeof source === 'string' && source.trim()) {
      if (!details.providerText) details.providerText = source.trim()
      continue
    }
    if (!source || typeof source !== 'object') continue
    for (const field of fields) {
      try {
        const value = source[field]
        if (value !== undefined && value !== null && value !== '') {
          if (details[field] === undefined) details[field] = value
        }
      } catch {}
    }
    try {
      if (source.response?.status !== undefined && details.httpStatus === undefined) {
        details.httpStatus = source.response.status
      }
      if (source.response?.statusText && details.statusText === undefined) {
        details.statusText = source.response.statusText
      }
      if (typeof source.response?.data === 'string' && !details.providerText) {
        details.providerText = source.response.data
      }
    } catch {}
  }
  let raw = ''
  if (Object.keys(details).length) {
    try { raw = JSON.stringify(details) } catch {}
  }
  if (!raw) {
    for (const source of sources) {
      if (typeof source === 'string' && source.trim()) { raw = source.trim(); break }
      if (source && typeof source === 'object') {
        try {
          const serialized = JSON.stringify(source)
          if (serialized && serialized !== '{}' && serialized !== '[object Object]') { raw = serialized; break }
        } catch {}
      }
    }
  }
  if (!raw) raw = 'Unknown wallet or provider error'
  if (/Confirmation declined by user|User rejected|code.?4001/i.test(raw)) return stage + ': Owner Wallet transaction was declined in the application. No retry was attempted. Details: ' + raw
  if (/Invalid transaction provided/i.test(raw)) return stage + ': The local Owner signer rejected the unsigned deployment transaction as invalid. Check the transaction payload and TRON Mainnet connection. Details: ' + raw
  if (/User has not unlocked wallet/i.test(raw)) return stage + ': unlock the Owner Wallet in TRON Transfer before trying again. Details: ' + raw
  return stage + ': ' + raw
}

function explainOwnerWalletError(error, stage) {
  return formatOwnerWalletError(error, stage)
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

export function predictMainnetContractAddress(tronWeb, ownerAddress, txID) {
  if (!tronWeb?.isAddress?.(ownerAddress)) throw new Error('Cannot predict a TRON contract address without a valid owner address.')
  if (!/^[0-9a-f]{64}$/i.test(String(txID || ''))) throw new Error('Cannot predict a TRON contract address without a valid transaction ID.')
  const ownerHex = String(tronWeb.address.toHex(ownerAddress) || '').replace(/^0x/, '').toLowerCase()
  if (!/^41[0-9a-f]{40}$/.test(ownerHex)) throw new Error('TRON returned an invalid owner address encoding for contract-address prediction.')
  const bytes = tronWeb.utils?.code?.hexStr2byteArray?.(String(txID).toLowerCase() + ownerHex)
  const keccak256 = tronWeb.utils?.ethersUtils?.keccak256
  if (!bytes || typeof keccak256 !== 'function') throw new Error('The pinned TronWeb client cannot derive the predicted Mainnet contract address.')
  const digest = String(keccak256(new Uint8Array(bytes))).replace(/^0x/, '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('TronWeb returned an invalid Keccak hash for contract-address prediction.')
  const predictedAddress = tronWeb.address.fromHex('41' + digest.slice(24))
  if (!tronWeb.isAddress(predictedAddress)) throw new Error('TronWeb derived an invalid predicted Mainnet contract address.')
  return predictedAddress
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
  // external wallet documents trx.sign(transaction) as accepting the unsigned
  // TronWeb transaction object returned by transactionBuilder. Do not rebuild
  // or whitelist fields here: CreateSmartContract has protocol-specific fields
  // (including contract_address and ABI encoding) that wallet versions may
  // validate as part of the complete builder result.
  // Pass the exact node-issued transaction object to external wallet. Its own
  // trx.sign implementation clones and validates the object internally.
  // Avoid an application-side JSON round-trip that could alter provider-specific
  // field representations before the wallet validates the payload.
  return transaction

}

export const MAINNET_DEPLOYMENT_SIGNING_ENABLED = true
export const MAINNET_DEPLOYMENT_BROADCAST_ENABLED = true

export async function preflightContractDeployments(wallet, deployments, {
  createVerifier = () => new TronWeb({ fullHost: TRON_MAINNET_HOST }),
  readResources = getMainnetAccountResourceSnapshot,
  readPermissions = getMainnetAccountPermissionSnapshot,
  estimateEnergy = estimateMainnetDeploymentEnergy,
 } = {}) {
  const walletTronWeb = assertMainnetWallet(wallet)
  if (!Array.isArray(deployments) || deployments.length === 0) {
    return { deployments: [], requiredTrxSun: '0', availableTrxSun: '0' }
  }
  const tronWeb = createVerifier()
  const resourceSnapshot = await readResources(tronWeb, wallet.address)
  const permissionSnapshot = await readPermissions(tronWeb, wallet.address)
  if (!permissionSnapshot.connectedSignerCanAuthorizeAlone) {
    throw new Error('Connected wallet cannot satisfy the TRON owner permission threshold alone. Collected weight '
      + permissionSnapshot.connectedSignerWeight + '; required threshold ' + permissionSnapshot.threshold
      + '; additional signer weight required ' + permissionSnapshot.requiredAdditionalWeight
      + '. No wallet signature or broadcast was attempted.')
  }

  // Spend the wallet's real resource snapshot across deployments in order.
  // Never reset quotas to zero: the earlier implementation overstated fees by
  // ignoring actual Energy and free/delegated Bandwidth shown by Mainnet.
  let remainingEnergy = BigInt(resourceSnapshot.energyAvailable)
  let remainingFreeBandwidth = BigInt(resourceSnapshot.freeBandwidthAvailable)
  let remainingStakedBandwidth = BigInt(resourceSnapshot.stakedBandwidthAvailable)
  const results = []
  let combinedRequiredTrxSun = 0n
  for (const deployment of deployments) {
    const { artifact, contractName, feeLimitSun } = deployment || {}
    let energyEstimate = null
  let energyEstimateWarning = ''
  try {
    energyEstimate = await estimateEnergy(tronWeb, wallet.address, artifact)
  } catch (error) {
    if (!isMainnetEnergyEstimateUnavailable(error)) throw error
    energyEstimateWarning = String(error?.message || error)
  }
    const options = buildDeploymentOptions(artifact, contractName, feeLimitSun)
    let unsigned
    try {      unsigned = await createMainnetDeploymentTransaction(tronWeb, options, wallet.address)
    } catch (error) {
      throw new Error(explainOwnerWalletError(error, 'Combined deployment preflight transaction construction failed'))
    }
    if (!unsigned?.raw_data_hex || !unsigned?.raw_data?.contract?.length
      || unsigned.raw_data.contract[0]?.type !== 'CreateSmartContract'
      || Number(unsigned.raw_data?.fee_limit) !== Number(feeLimitSun)) {
      throw new Error('Mainnet returned an incomplete or unexpected unsigned transaction during combined deployment preflight. No wallet signature or broadcast was attempted.')
    }
    if (energyEstimate) {
      const snapshotForThisDeployment = {
        ...resourceSnapshot,
        energyAvailable: remainingEnergy.toString(),
        freeBandwidthAvailable: remainingFreeBandwidth.toString(),
        stakedBandwidthAvailable: remainingStakedBandwidth.toString(),
      }
      const budget = calculateDeploymentResourceBudget({
        energyRequired: energyEstimate.energyUsed,
        resourceSnapshot: snapshotForThisDeployment,
        rawDataHex: unsigned.raw_data_hex,
        feeLimitSun,
      })
      remainingEnergy = BigInt(budget.energyShortfall) > 0n
        ? 0n
        : remainingEnergy - BigInt(budget.energyWithSafetyMargin)
      const txBandwidth = BigInt(budget.estimatedBandwidthBytes)
      if (remainingFreeBandwidth >= txBandwidth) remainingFreeBandwidth -= txBandwidth
      else if (remainingStakedBandwidth >= txBandwidth) remainingStakedBandwidth -= txBandwidth
      combinedRequiredTrxSun += BigInt(budget.requiredTrxSun)
      results.push({
        contractName: String(contractName),
        energyEstimateAvailable: true,
        energyRequired: budget.energyRequired,
        energyWithSafetyMargin: budget.energyWithSafetyMargin,
        estimatedBandwidthBytes: budget.estimatedBandwidthBytes,
        requiredTrxSun: budget.requiredTrxSun,
      })
    } else {
      results.push({
        contractName: String(contractName),
        energyEstimateAvailable: false,
        energyEstimateWarning,
        energyRequired: null,
        energyWithSafetyMargin: null,
        estimatedBandwidthBytes: null,
        requiredTrxSun: null,
      })
    }
  }
  return {
    deployments: results,
    requiredTrxSun: combinedRequiredTrxSun.toString(),
    conservative: results.every(item => item.energyEstimateAvailable),
    energyEstimateAvailable: results.every(item => item.energyEstimateAvailable),
  }
}

export async function deployContractWithOwnerSigner(wallet, artifact, contractName, feeLimitSun, {
  createVerifier = () => new TronWeb({ fullHost: TRON_MAINNET_HOST }),
  waitForReceipt = waitForSolidifiedReceipt,
  verifyDeployedContract = async (client, address) => client.trx.getContractInfo(address),
  verifyDeployedOwner = async (client, artifact, address) => {
    const instance = await client.contract(artifact.abi).at(address)
    return instance.owner().call()
  },
  readResources = getMainnetAccountResourceSnapshot,
  readPermissions = getMainnetAccountPermissionSnapshot,
  estimateEnergy = estimateMainnetDeploymentEnergy,
  expectedOwnerAddress = '',
  confirmAction = (message) => typeof window === 'undefined' || window.confirm(message),
} = {}) {
  // Build, sign and broadcast through the same encrypted local Owner Wallet
  // TronWeb instance. The separate pinned client remains read-only and
  // independently verifies raw_data, txID, signatures, permissions, receipts
  // and deployed bytecode. No external wallet provider or external wallet is consulted.
  const walletTronWeb = assertMainnetWallet(wallet)
  const tronWeb = createVerifier()
  if (expectedOwnerAddress && !addressesEqual(tronWeb, wallet.address, expectedOwnerAddress)) {
    throw new Error('Configured TRӾ owner does not match the connected funded Mainnet account. Expected '
      + expectedOwnerAddress + '; connected ' + wallet.address + '. No wallet prompt or broadcast was attempted.')
  }
  const localSignerAddress = walletTronWeb.defaultAddress?.base58
    || walletTronWeb.defaultAddress?.hex
    || ''
  if (localSignerAddress && !addressesEqual(tronWeb, localSignerAddress, wallet.address)) {
    throw new Error('Owner signer active address (' + localSignerAddress
      + ') differs from the connected app account (' + wallet.address
      + '). Unlock the configured funded Owner Wallet and retry. No signature or broadcast was attempted.')
  }
  if (typeof walletTronWeb?.trx?.sign !== 'function'
    || typeof walletTronWeb?.trx?.sendRawTransaction !== 'function'
    || !tronWeb?.utils?.transaction?.txCheck
    || !tronWeb?.utils?.crypto?.ecRecover
    || typeof tronWeb?.trx?.getSignWeight !== 'function') {
    throw new Error('The local Owner signer cannot sign and broadcast Mainnet deployments, or the pinned verifier cannot validate signatures and permissions.')
  }
  // Pace the preflight reads instead of bursting resource, permission and
  // deployment-simulation requests at the public TronGrid endpoint together.
  const resourceSnapshot = await readResources(tronWeb, wallet.address)
  // A zero TRX balance is not automatically fatal when the owner has enough
  // delegated/staked Energy and Bandwidth to cover the complete deployment.
  // The exact resource budget is checked below before any wallet prompt.
  const permissionSnapshot = await readPermissions(tronWeb, wallet.address)
  let energyEstimate = null
  let energyEstimateWarning = ''
  try {
    energyEstimate = await estimateEnergy(tronWeb, wallet.address, artifact)
  } catch (error) {
    if (!isMainnetEnergyEstimateUnavailable(error)) throw error
    energyEstimateWarning = String(error?.message || error)
  }
  if (!permissionSnapshot.connectedSignerCanAuthorizeAlone) {
    throw new Error('Connected wallet cannot satisfy the TRON owner permission threshold alone. Collected weight '
      + permissionSnapshot.connectedSignerWeight + '; required threshold ' + permissionSnapshot.threshold
      + '; additional signer weight required ' + permissionSnapshot.requiredAdditionalWeight
      + '. No wallet signature or broadcast was attempted.')
  }
  const options = buildDeploymentOptions(artifact, contractName, feeLimitSun)
  let unsigned
  try {
    unsigned = await createMainnetDeploymentTransaction(tronWeb, options, wallet.address)
  } catch (error) {
    throw new Error(explainOwnerWalletError(error, 'Deployment transaction construction failed'))
  }
  if (!unsigned?.txID || !/^[0-9a-f]{64}$/i.test(unsigned.txID) || !unsigned?.raw_data?.contract?.length) {
    throw new Error('TRON Mainnet returned an incomplete deployment transaction. No signature or broadcast was attempted.')
  }
  const createContract = unsigned.raw_data.contract[0]
  const ownerHex = createContract?.parameter?.value?.owner_address
  let transactionOwner = ''
  try { transactionOwner = ownerHex ? tronWeb.address.fromHex(ownerHex) : '' } catch {}
  if (createContract?.type !== 'CreateSmartContract' || !transactionOwner
    || !addressesEqual(tronWeb, transactionOwner, wallet.address)) {
    throw new Error('Deployment transaction owner does not match the configured Owner Wallet. Unlock the intended Owner Wallet and retry. No signature or broadcast was attempted.')
  }
  const predictedAddress = predictMainnetContractAddress(tronWeb, wallet.address, unsigned.txID)
  if (Number(unsigned.raw_data?.fee_limit) !== Number(feeLimitSun)) {
    throw new Error('Mainnet node changed the requested deployment fee_limit. No wallet signature or broadcast was attempted.')
  }
  let resourceBudget
  if (!energyEstimate) {
    throw new Error('Deployment Energy simulation is unavailable on the selected TRON Mainnet node. The app will not ask the local Owner signer to sign or broadcast an unpriced deployment. Switch to a Mainnet node that supports wallet/estimateenergy, then retry. No signature or broadcast was attempted.')
  }
  resourceBudget = calculateDeploymentResourceBudget({
    energyRequired: energyEstimate.energyUsed,
    resourceSnapshot,
    rawDataHex: unsigned.raw_data_hex,
    feeLimitSun,
  })
  assertZeroTrxBurnBudget(resourceBudget)
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
  const walletTxCheck = walletTronWeb?.utils?.transaction?.txCheck
  let walletTransactionIntegrity = null
  if (typeof walletTxCheck === 'function') {
    try { walletTransactionIntegrity = walletTxCheck(walletTransaction) === true } catch { walletTransactionIntegrity = false }
    if (!walletTransactionIntegrity) {
      throw new Error('The local Owner TronWeb signer rejects the node-issued CreateSmartContract payload before signing. No wallet prompt or broadcast was attempted. Check the wallet version and transaction serialization.')
    }
  }
  // Re-read the exact fee-paying Owner account immediately before local
  // signing. The initial balance/resource snapshot may become stale while
  // simulation and transaction construction run; do not rely on it.
  const finalResourceSnapshot = await readResources(tronWeb, wallet.address)
  resourceBudget = calculateDeploymentResourceBudget({
    energyRequired: energyEstimate.energyUsed,
    resourceSnapshot: finalResourceSnapshot,
    rawDataHex: walletTransaction.raw_data_hex,
    feeLimitSun,
    safetyMarginBps: 12500,
  })
  assertZeroTrxBurnBudget(resourceBudget)
  if (!confirmAction('Approve TRӾ Mainnet deployment?\n\nOwner: ' + wallet.address + '\nPredicted contract: ' + predictedAddress + '\nFee limit: ' + (Number(feeLimitSun) / 1e6) + ' TRX\nEstimated Energy: ' + resourceBudget.energyRequired + '\n\nThe platform will sign locally and broadcast only after the final resource checks.')) {
    throw new Error('Owner cancelled the deployment confirmation. No signature or broadcast was attempted.')
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
      walletTronWebVersion: String(walletTronWeb.version || 'unknown'),
      signerKind: String(wallet.signerType || 'unknown-local-signer'),
      walletTransactionIntegrity,
      energyEstimateAvailable: Boolean(energyEstimate),
      energyEstimateWarning: energyEstimateWarning || null,
      transactionType: contract?.type || 'unknown',
      parameterTypeUrl: contract?.parameter?.type_url || 'missing',
      hasOwnerAddress: Boolean(value.owner_address),
      hasNewContract: Boolean(value.new_contract),
      bytecodeLength: String(newContract.bytecode || '').length,
      abiEntries: Array.isArray(newContract.abi?.entrys) ? newContract.abi.entrys.length : Array.isArray(newContract.abi) ? newContract.abi.length : null,
      contractAddressPresent: Boolean(walletTransaction.contract_address),
      originAddressPresent: Boolean(newContract.origin_address),
      contractName: String(newContract.name || ''),
      feeLimitSun: walletTransaction.raw_data.fee_limit ?? null,
      rawDataHexLength: walletTransaction.raw_data_hex.length,
      energyEstimateAvailable: Boolean(energyEstimate),
      estimatedEnergy: resourceBudget.energyRequired,
      energyWithSafetyMargin: resourceBudget.energyWithSafetyMargin,
      estimatedTrxShortfallSun: resourceBudget.requiredTrxSun,
    }
    throw new Error(explainOwnerWalletError(error, 'Owner Wallet signing failed') + ' Payload diagnostics: ' + JSON.stringify(diagnostic))
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
    throw new Error('Owner signer result failed cryptographic payload consistency validation (' + reason + '). Nothing was broadcast.')
  }
  // The signature is verified against the original raw_data bytes; rebuild only
  // the protocol transaction envelope so omitted Android provider fields cannot
  // change the signed payload.
  const signedTransaction = { ...walletTransaction, signature: [...signatures] }
  assertTransactionIntegrity(tronWeb, signedTransaction, 'Signed deployment transaction')
  verifyTransactionSigner(tronWeb, signedTransaction, wallet.address)
  await assertTransactionPermission(tronWeb, signedTransaction, wallet.address)

  // Resources can change while the Owner reviews the local signing confirmation.
  // Re-read the exact fee-paying owner immediately after signing and directly
  // before broadcast. If any TRX fallback has appeared, discard the signature.
  try {
    const preBroadcastResourceSnapshot = await readResources(tronWeb, wallet.address)
    const preBroadcastBudget = calculateDeploymentResourceBudget({
      energyRequired: energyEstimate.energyUsed,
      resourceSnapshot: preBroadcastResourceSnapshot,
      rawDataHex: signedTransaction.raw_data_hex,
      feeLimitSun,
      safetyMarginBps: 12500,
    })
    assertZeroTrxBurnBudget(preBroadcastBudget)
  } catch (error) {
    throw new Error('Owner signer signed the deployment, but the transaction was NOT broadcast because the final zero-TRX-burn resource recheck failed: '
      + String(error?.message || error)
      + '. The signed transaction was discarded. No network fee was paid.')
  }

  if (!MAINNET_DEPLOYMENT_BROADCAST_ENABLED) {
    throw new Error('Mainnet deployment broadcasting is disabled. Signature was validated, but the transaction was not broadcast.')
  }
  let broadcast
  try {
    broadcast = await walletTronWeb.trx.sendRawTransaction(signedTransaction)
  } catch (error) {
    throw new Error(explainOwnerWalletError(error, 'Deployment broadcast request failed') + ' Check TRONSCAN for transaction ' + unsigned.txID + ' before retrying.')
  }
  if (broadcast?.result !== true) throw new Error(decodeTronBroadcastFailure(tronWeb, broadcast, unsigned.txID))
  let verifiedDeployment
  try {
    verifiedDeployment = await verifyExistingMainnetDeployment(tronWeb, {
      txID: unsigned.txID,
      ownerAddress: wallet.address,
      artifact,
      contractAddress: predictedAddress,
    }, { waitForReceipt, verifyDeployedContract, verifyDeployedOwner })
  } catch (error) {
    throw new Error('Deployment broadcast was accepted, but final Mainnet verification did not complete. Preserve transaction ' + unsigned.txID + ' and recover it with verifyExistingMainnetDeployment; do not submit a duplicate deployment. ' + (error?.message || String(error)))
  }
  return { ...verifiedDeployment, resourceBudget, payerAddress: wallet.address, signerAddress: localSignerAddress || wallet.address }
}

export const deployContractFromOwnerWallet = deployContractWithOwnerSigner

export async function estimateMainnetContractCallEnergy(tronWeb, contractAddress, encodedCallData, ownerAddress, requestNode = postNode) {
  return estimateMainnetContractCallEnergyShared(tronWeb, contractAddress, encodedCallData, ownerAddress, requestNode)
}

export async function sendAndVerifyContractCall(
  tronWeb,
  tokenContract,
  methodName,
  methodArgs = [],
  feeLimitSun = 150000000,
  ownerAddress = '',
  {
    readResources = getMainnetAccountResourceSnapshot,
    readPermissions = getMainnetAccountPermissionSnapshot,
    estimateEnergy = estimateMainnetContractCallEnergy,
    waitForReceipt = waitForSolidifiedReceipt,
    signTransaction = (transaction) => tronWeb.trx.sign(transaction),
    broadcastTransaction = (transaction) => tronWeb.trx.sendRawTransaction(transaction),
    checkTransactionIntegrity = assertTransactionIntegrity,
    hashRawData = sha256HexFromBytes,
    checkTransactionSigner = verifyTransactionSigner,
    checkTransactionPermission = assertTransactionPermission,
    confirmAction = (message) => typeof window === 'undefined' || window.confirm(message),
  } = {}
) {
  if (!tronWeb?.isAddress?.(ownerAddress)) {
    throw new Error('TRӾ contract calls require the connected TRON Mainnet transaction owner address.')
  }
  const walletAddress = tronWeb.defaultAddress?.base58 || ''
  if (!walletAddress || !addressesEqual(tronWeb, walletAddress, ownerAddress)) {
    throw new Error('The local Owner signing address does not match the configured TRӾ transaction owner. No signature or broadcast was attempted.')
  }
  if (typeof tronWeb?.trx?.sign !== 'function' || typeof tronWeb?.trx?.sendRawTransaction !== 'function') {
    throw new Error('The local Owner signer cannot sign and broadcast TRON Mainnet contract calls.')
  }
  const methodInstance = tokenContract?.methodInstances?.[methodName]
  const contractAddress = tokenContract?.address
  const methodContractAddress = methodInstance?.contract?.address
  if (!tronWeb.isAddress(contractAddress) || !tokenContract?.deployed || !methodInstance?.abi
    || typeof methodInstance.functionSelector !== 'string' || !methodInstance.functionSelector
    || !tronWeb.isAddress(methodContractAddress)
    || !addressesEqual(tronWeb, methodContractAddress, contractAddress)) {
    throw new Error('The selected TRӾ contract method is unavailable or belongs to a different contract instance. Verify the ABI and deployed address.')
  }
  if (methodInstance.abi.stateMutability && ['view', 'pure'].includes(String(methodInstance.abi.stateMutability).toLowerCase())) {
    throw new Error('Read-only contract methods cannot be sent as owner transactions.')
  }
  const inputs = Array.isArray(methodInstance.abi.inputs) ? methodInstance.abi.inputs : []
  if (!Array.isArray(methodArgs) || methodArgs.length !== inputs.length) {
    throw new Error('TRӾ ' + methodName + ' argument count does not match the verified contract ABI.')
  }
  const feeLimit = Number(feeLimitSun)
  if (!Number.isSafeInteger(feeLimit) || feeLimit <= 0) {
    throw new Error('Enter a positive whole-number TRX fee limit in SUN for this contract operation.')
  }
  const localSigner = tronWeb.defaultAddress?.base58 || tronWeb.defaultAddress?.hex || ''
  if (!addressesEqual(tronWeb, localSigner, ownerAddress)) {
    throw new Error('The active Owner signer no longer matches the connected transaction owner.')
  }

  // Build the node-issued unsigned transaction for the same ABI function and arguments.
  // funcABIV2/parametersV2 make TronWeb encode with the method's own ABI fragment.
  const options = {
    feeLimit,
    callValue: 0,
    from: ownerAddress,
    funcABIV2: methodInstance.abi,
    parametersV2: methodArgs,
  }
  let built
  try {
    built = await tronWeb.transactionBuilder.triggerSmartContract(
      contractAddress,
      methodInstance.functionSelector,
      options,
      [],
      tronWeb.address.toHex(ownerAddress)
    )
  } catch (error) {
    throw new Error('TRON Mainnet could not construct the TRӾ ' + methodName + ' transaction. No wallet prompt or broadcast was attempted. '
      + String(error?.message || error))
  }
  const unsigned = built?.transaction || built
  if (!built?.result?.result || !unsigned?.txID || !/^[0-9a-f]{64}$/i.test(unsigned.txID)
    || !unsigned?.raw_data_hex || !unsigned?.raw_data?.contract?.length
    || unsigned.raw_data.contract.length !== 1
    || unsigned.raw_data.contract[0]?.type !== 'TriggerSmartContract') {
    throw new Error('TRON Mainnet returned an incomplete or unsuccessful TRӾ ' + methodName + ' transaction. No signature or broadcast was attempted.')
  }
  const value = unsigned.raw_data.contract[0]?.parameter?.value || {}
  let transactionOwner = ''
  let transactionContract = ''
  try {
    transactionOwner = value.owner_address ? tronWeb.address.fromHex(value.owner_address) : ''
    transactionContract = value.contract_address ? tronWeb.address.fromHex(value.contract_address) : ''
  } catch {}
  const txData = String(value.data || '').replace(/^0x/, '').toLowerCase()
  const expectedSelector = String(methodInstance.signature || '').replace(/^0x/, '').toLowerCase()
  if (!transactionOwner || !addressesEqual(tronWeb, transactionOwner, ownerAddress)
    || !transactionContract || !addressesEqual(tronWeb, transactionContract, contractAddress)
    || !expectedSelector || !txData.startsWith(expectedSelector)
    || Number(value.call_value ?? 0) !== 0
    || Number(unsigned.raw_data.fee_limit) !== feeLimit) {
    throw new Error('Unsigned TRӾ ' + methodName + ' transaction does not match the verified owner, contract, method selector, zero call value or selected fee limit. No signature or broadcast was attempted.')
  }

  // Simulate the exact encoded data that the encrypted local Owner Wallet will sign.
  // postNode routes both the preferred estimator and its fallback through the paced queue.
  let energyEstimate
  try {
    energyEstimate = await estimateEnergy(tronWeb, contractAddress, txData, ownerAddress)
  } catch (error) {
    throw new Error('TRӾ ' + methodName + ' Energy preflight failed. No wallet prompt or broadcast was attempted. '
      + String(error?.message || error))
  }
  if (!energyEstimate?.energyUsed || BigInt(energyEstimate.energyUsed) <= 0n) {
    throw new Error('TRON Mainnet did not return a valid positive Energy estimate for TRӾ ' + methodName + '. No signature or broadcast was attempted.')
  }

  checkTransactionIntegrity(tronWeb, unsigned, 'Unsigned TRӾ ' + methodName + ' transaction')
  const computedTxID = await hashRawData(unsigned.raw_data_hex)
  if (computedTxID.toLowerCase() !== unsigned.txID.toLowerCase()) {
    throw new Error('TRON node transaction ID does not match SHA-256(raw_data_hex) for TRӾ ' + methodName + '. No signature or broadcast was attempted.')
  }

  const permissionSnapshot = await readPermissions(tronWeb, ownerAddress)
  if (!permissionSnapshot?.connectedSignerCanAuthorizeAlone) {
    throw new Error('Connected wallet cannot satisfy the TRON owner permission threshold alone for TRӾ ' + methodName
      + '. Additional signer weight required: ' + String(permissionSnapshot?.requiredAdditionalWeight ?? 'unknown')
      + '. No wallet signature or broadcast was attempted.')
  }

  const calculateBudget = async () => {
    const resourceSnapshot = await readResources(tronWeb, ownerAddress)
    return calculateDeploymentResourceBudget({
      energyRequired: energyEstimate.energyUsed,
      resourceSnapshot,
      rawDataHex: unsigned.raw_data_hex,
      feeLimitSun: feeLimit,
      safetyMarginBps: 12500,
      transactionLabel: 'TRӾ ' + methodName + ' operation',
    })
  }

  // Re-read resource quotas immediately before the local Owner signature request.
  const initialBudget = await calculateBudget()
  assertZeroTrxBurnBudget(initialBudget)
  if (!confirmAction('Approve TRӾ Mainnet ' + methodName + '?\n\nOwner: ' + ownerAddress + '\nContract: ' + contractAddress + '\nFee limit: ' + (feeLimit / 1e6) + ' TRX\nEstimated Energy: ' + energyEstimate.energyUsed + '\n\nThe platform will sign locally and broadcast only after the final resource checks.')) {
    throw new Error('Owner cancelled the transaction confirmation. No signature or broadcast was attempted.')
  }

  const walletTxCheck = tronWeb?.utils?.transaction?.txCheck
  if (typeof walletTxCheck !== 'function' || walletTxCheck(unsigned) !== true) {
    throw new Error('Owner signer transaction integrity validation is unavailable or rejected the unsigned TRӾ ' + methodName + ' payload. No signature or broadcast was attempted.')
  }

  let signed
  try {
    signed = await signTransaction(unsigned)
  } catch (error) {
    throw new Error(formatOwnerWalletError(error, 'Owner Wallet TRӾ ' + methodName + ' signing failed') + ' Nothing was broadcast.')
  }
  const signatures = signed?.signature
  const signatureValid = Array.isArray(signatures) && signatures.length === 1
    && typeof signatures[0] === 'string' && /^[0-9a-f]{130}$/i.test(signatures[0])
  const rawDataMatches = signed?.raw_data_hex == null
    || (typeof signed.raw_data_hex === 'string' && signed.raw_data_hex.toLowerCase() === unsigned.raw_data_hex.toLowerCase())
  if (!signed || !signatureValid || String(signed.txID || '').toLowerCase() !== unsigned.txID.toLowerCase() || !rawDataMatches) {
    throw new Error('Owner signer result changed or omitted the expected TRӾ ' + methodName + ' transaction payload. Nothing was broadcast.')
  }
  const signedTransaction = { ...unsigned, signature: [...signatures] }
  checkTransactionIntegrity(tronWeb, signedTransaction, 'Signed TRӾ ' + methodName + ' transaction')
  checkTransactionSigner(tronWeb, signedTransaction, ownerAddress)
  await checkTransactionPermission(tronWeb, signedTransaction, ownerAddress)

  // A user may leave the local transaction confirmation open long enough for quotas to change.
  // Discard an accepted signature if the final pre-broadcast snapshot no longer
  // covers the exact operation without any TRX fallback.
  let finalBudget
  try {
    finalBudget = await calculateBudget()
    assertZeroTrxBurnBudget(finalBudget)
  } catch (error) {
    throw new Error('The local Owner signer signed TRӾ ' + methodName + ', but it was NOT broadcast because the final zero-TRX-burn resource check failed. The signed transaction was discarded; no network fee was paid. '
      + String(error?.message || error))
  }

  let broadcast
  try {
    broadcast = await broadcastTransaction(signedTransaction)
  } catch (error) {
    throw new Error(formatOwnerWalletError(error, 'TRON Mainnet TRӾ ' + methodName + ' broadcast failed') + ' Check the transaction ID before retrying: ' + unsigned.txID)
  }
  if (broadcast?.result !== true) {
    throw new Error('TRON Mainnet rejected the TRӾ ' + methodName + ' broadcast. Transaction: ' + unsigned.txID
      + '. ' + decodeNodeErrorText(broadcast?.message || broadcast?.code || 'unknown broadcast error'))
  }
  const receipt = await waitForReceipt(tronWeb, unsigned.txID)
  if (receipt?.receipt?.result !== 'SUCCESS') {
    throw new Error('TRӾ ' + methodName + ' transaction was not confirmed successful on solidified Mainnet. Transaction: ' + unsigned.txID)
  }
  return { txID: unsigned.txID, receipt, resourceBudget: finalBudget, payerAddress: ownerAddress, signerAddress: ownerAddress }
}

export async function sendNativeTrxFromOwnerWallet(wallet, toAddress, amountSun) {
  const tronWeb = assertMainnetWallet(wallet)
  if (!tronWeb.isAddress(toAddress)) throw new Error('Invalid reserve-vault TRON address.')
  const amount = BigInt(String(amountSun))
  if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid TRX funding amount.')
  const unsigned = await tronWeb.transactionBuilder.sendTrx(toAddress, Number(amount), wallet.address)
  const signed = await tronWeb.trx.sign(unsigned)
  if (!signed?.signature?.length) throw new Error('The Owner Wallet did not sign the native TRX funding transaction.')
  const broadcast = await tronWeb.trx.sendRawTransaction(signed)
  if (broadcast?.result !== true) throw new Error('TRON Mainnet rejected the TRX funding transfer.')
  const receipt = await waitForSolidifiedReceipt(tronWeb, unsigned.txID)
  return { txID: unsigned.txID, receipt }
}

export const MAINNET_USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const MAINNET_ERC20_BALANCE_ABI = [{
  constant: true,
  inputs: [{ name: 'account', type: 'address' }],
  name: 'balanceOf',
  outputs: [{ name: '', type: 'uint256' }],
  stateMutability: 'view',
  type: 'function',
}]

export async function getMainnetUSDTBalance(tronWeb, address) {
  if (!tronWeb?.isAddress?.(address)) throw new Error('Enter a valid TRON Mainnet account address.')
  const token = await tronWeb.contract(MAINNET_ERC20_BALANCE_ABI).at(MAINNET_USDT_CONTRACT)
  const balance = await callMainnetView(token.balanceOf(address))
  const normalized = String(balance)
  if (!/^(?:0|[1-9][0-9]*)$/.test(normalized)) throw new Error('Official USDT contract returned an invalid balance.')
  return normalized
}