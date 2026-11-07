import { TronWeb } from 'tronweb'
import { isValidTronAddress } from './tron-address.mjs'
import { tatumProviderFetch } from './tatum-provider-fetch.mjs'

const MAINNET_GATEWAY = 'https://tron-mainnet.gateway.tatum.io'
const OFFICIAL_USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const ADDRESS_HEX_RE = /^(?:41)?[0-9a-f]{40}$/i
const BLOCK_ID_RE = /^[0-9a-f]{64}$/i
const UINT_RE = /^(?:0|[1-9][0-9]{0,77})$/
const REQUEST_TIMEOUT_MS = 12_000

function fail(code, status = 503) {
  const error = new Error(code)
  error.code = code
  error.status = status
  return error
}

function uintString(value, code) {
  const normalized = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : typeof value === 'string' ? value : ''
  if (!UINT_RE.test(normalized)) throw fail(code, 502)
  return BigInt(normalized).toString()
}

function safeResource(value, code) {
  const result = uintString(value, code)
  if (BigInt(result) > BigInt(Number.MAX_SAFE_INTEGER)) throw fail(code, 502)
  return result
}

function returnedAddress(value, tronWeb) {
  if (typeof value !== 'string') return ''
  if (isValidTronAddress(value)) return value
  if (!ADDRESS_HEX_RE.test(value)) return ''
  try {
    const hex = value.replace(/^0x/i, '')
    const decoded = tronWeb.address.fromHex(hex.length === 40 ? '41' + hex : hex)
    return isValidTronAddress(decoded) ? decoded : ''
  } catch {
    return ''
  }
}

function readApiKey(env) {
  const key = typeof env.TATUM_MAINNET_API_KEY === 'string' && env.TATUM_MAINNET_API_KEY.trim()
    ? env.TATUM_MAINNET_API_KEY.trim()
    : typeof env.TATUM_API_KEY === 'string' ? env.TATUM_API_KEY.trim() : ''
  return key.length >= 12 ? key : ''
}

async function postReadOnly(path, body, { apiKey, fetchImpl, timeoutMs }) {
  const response = await fetchImpl(MAINNET_GATEWAY + path, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response || response.ok !== true) {
    throw fail('TATUM_MAINNET_READ_FAILED', response && Number.isInteger(response.status) ? 502 : 503)
  }
  let payload
  try { payload = await response.json() } catch { throw fail('TATUM_MAINNET_RESPONSE_INVALID', 502) }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw fail('TATUM_MAINNET_RESPONSE_INVALID', 502)
  }
  return payload
}

/**
 * Authenticated, read-only TRON Mainnet observation adapter.
 *
 * Uses the repository's existing server-side Tatum credential contract and
 * fixed Tatum Mainnet gateway. Only four read-only RPC methods are callable.
 * It does not query custody providers, inspect private keys, create transactions,
 * contact signers, sign, or broadcast. TLS/API-key authentication does not make
 * Tatum responses cryptographically attested; callers must retain verified:false.
 */
export async function readAuthenticatedTronMainnetSponsorObservation({
  sponsorAddress,
  env = process.env,
  fetchImpl = tatumProviderFetch,
  now = Date.now,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  if (!isValidTronAddress(sponsorAddress)) throw fail('SPONSOR_ADDRESS_INVALID', 400)
  if (typeof fetchImpl !== 'function' || typeof now !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30_000) {
    throw fail('READ_ONLY_OBSERVER_CONFIGURATION_INVALID', 400)
  }
  const apiKey = readApiKey(env)
  if (!apiKey) throw fail('TATUM_MAINNET_CREDENTIAL_MISSING', 503)

  const tronWeb = new TronWeb({ fullHost: MAINNET_GATEWAY })
  const addressHex = tronWeb.address.toHex(sponsorAddress).replace(/^41/i, '').toLowerCase()
  const [block, account, resources, token] = await Promise.all([
    postReadOnly('/walletsolidity/getnowblock', {}, { apiKey, fetchImpl, timeoutMs }),
    postReadOnly('/walletsolidity/getaccount', { address: sponsorAddress, visible: true }, { apiKey, fetchImpl, timeoutMs }),
    postReadOnly('/wallet/getaccountresource', { address: sponsorAddress, visible: true }, { apiKey, fetchImpl, timeoutMs }),
    postReadOnly('/walletsolidity/triggerconstantcontract', {
      owner_address: sponsorAddress,
      contract_address: OFFICIAL_USDT_CONTRACT,
      function_selector: 'balanceOf(address)',
      parameter: addressHex.padStart(64, '0'),
      visible: true,
    }, { apiKey, fetchImpl, timeoutMs }),
  ])

  const blockId = block.blockID
  const blockNumber = block.block_header?.raw_data?.number
  if (typeof blockId !== 'string' || !BLOCK_ID_RE.test(blockId)
    || !Number.isSafeInteger(blockNumber) || blockNumber < 1) {
    throw fail('TRON_SOLIDIFIED_BLOCK_METADATA_INVALID', 502)
  }

  const observedAddress = returnedAddress(account.address, tronWeb)
  if (observedAddress !== sponsorAddress) throw fail('TRON_SPONSOR_ACCOUNT_NOT_CONFIRMED', 502)
  const trxBalanceSun = uintString(account.balance, 'TRON_SPONSOR_TRX_BALANCE_INVALID')

  const constantResult = token.constant_result
  if (!Array.isArray(constantResult) || constantResult.length !== 1
    || typeof constantResult[0] !== 'string' || !/^[0-9a-f]{1,64}$/i.test(constantResult[0])) {
    throw fail('TRON_OFFICIAL_USDT_BALANCE_INVALID', 502)
  }
  const usdtBalanceBaseUnits = BigInt('0x' + constantResult[0]).toString()

  const resourcesSnapshot = {
    freeNetLimit: safeResource(resources.freeNetLimit, 'TRON_FREE_BANDWIDTH_INVALID'),
    freeNetUsed: safeResource(resources.freeNetUsed, 'TRON_FREE_BANDWIDTH_INVALID'),
    netLimit: safeResource(resources.NetLimit, 'TRON_STAKED_BANDWIDTH_INVALID'),
    netUsed: safeResource(resources.NetUsed, 'TRON_STAKED_BANDWIDTH_INVALID'),
    energyLimit: safeResource(resources.EnergyLimit, 'TRON_ENERGY_INVALID'),
    energyUsed: safeResource(resources.EnergyUsed, 'TRON_ENERGY_INVALID'),
  }
  const observedAt = now()
  if (!Number.isSafeInteger(observedAt) || observedAt <= 0) throw fail('TRON_OBSERVATION_CLOCK_INVALID', 500)

  return Object.freeze({
    source: 'tron-mainnet-readonly-rpc',
    sourceProvider: 'tatum',
    sourceAuthentication: 'https-api-key',
    sourceCryptographicallyAttested: false,
    network: 'TRON_MAINNET',
    finality: 'solidified',
    sponsorAddress,
    accountExists: true,
    blockNumber,
    blockId: blockId.toLowerCase(),
    blockTimestamp: Number.isSafeInteger(block.block_header?.raw_data?.timestamp)
      ? block.block_header.raw_data.timestamp : null,
    observedAt,
    usdtContract: OFFICIAL_USDT_CONTRACT,
    usdtDecimals: 6,
    usdtBalanceBaseUnits,
    trxBalanceSun,
    resources: Object.freeze(resourcesSnapshot),
    resourcesFinality: 'latest-node-resource-snapshot',
    limitations: Object.freeze({
      custodyProviderObserved: false,
      sponsorLegalAuthorityVerified: false,
      walletControlVerified: false,
      providerSignerAuthorityVerified: false,
      providerResponseCryptographicallyAttested: false,
      payoutAuthorized: false,
      signerProviderContacted: false,
      signingRequestCreated: false,
      transactionSigned: false,
      broadcastAttempted: false,
      mainnetExecutionEnabled: false,
    }),
  })
}

export default readAuthenticatedTronMainnetSponsorObservation
