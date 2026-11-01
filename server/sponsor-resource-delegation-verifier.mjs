import { createHash } from 'node:crypto'
import { tatumProviderFetch } from './tatum-provider-fetch.mjs'
import { isValidTronAddress } from './tron-address.mjs'
const NETWORKS = Object.freeze({
  mainnet: { host: 'https://tron-mainnet.gateway.tatum.io' },
  shasta: { host: 'https://tron-shasta.gateway.tatum.io' },
  nile: { host: 'https://tron-nile.gateway.tatum.io' },
})
const TX_PATTERN = /^[0-9a-f]{64}$/i
const INTEGER_PATTERN = /^(0|[1-9][0-9]{0,77})$/

function normalizeAddress(tronWeb, value) {
  if (typeof value !== 'string') return ''
  try {
    const base58 = value.startsWith('T') ? value : tronWeb.address.fromHex(value)
    return tronWeb.address.toHex(base58).replace(/^0x/i, '').toLowerCase()
  } catch {
    return ''
  }
}

function numericText(value) {
  if (typeof value === 'string' && INTEGER_PATTERN.test(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  return null
}

function normalizeResource(value) {
  if (value === 1 || value === '1' || value === 'ENERGY') return 'ENERGY'
  if (value === 0 || value === '0' || value === 'BANDWIDTH') return 'BANDWIDTH'
  return null
}

/**
 * Independent confirmation of a sponsor-initiated Stake-2.0 resource delegation.
 * It does not broadcast transactions. Both the exact solidified transaction and
 * the resulting solidified delegation state must match the caller's expected values.
 */
export function createSponsorResourceDelegationVerifier({
  env = process.env,
  fetchImpl = tatumProviderFetch,
  tronWebFactory = async (host, headers) => {
    const { TronWeb } = await import('tronweb')
    return new TronWeb({ fullHost: host, headers })
  },
  timeoutMs = 8000,
} = {}) {
  return async function verifySponsorResourceDelegation(input) {
    const fail = (status, reason, extra = {}) => ({
      success: false,
      verified: false,
      status,
      reason,
      ...extra,
    })
    const { network, transactionId, sponsorAddress, receiverAddress, resourceType, stakeEquivalentSun } = input || {}
    if (typeof network !== 'string' || !Object.hasOwn(NETWORKS, network)) return fail('invalid-network', 'invalid-network')
    if (typeof transactionId !== 'string' || !TX_PATTERN.test(transactionId)
      || !isValidTronAddress(sponsorAddress)
      || !isValidTronAddress(receiverAddress)
      || sponsorAddress === receiverAddress
      || !['ENERGY', 'BANDWIDTH'].includes(resourceType)
      || typeof stakeEquivalentSun !== 'string' || !/^[1-9][0-9]{0,15}$/.test(stakeEquivalentSun)) {
      return fail('invalid-request', 'invalid-delegation-details')
    }
    if (typeof env.TATUM_API_KEY !== 'string' || !env.TATUM_API_KEY.trim()) {
      return fail('provider-credentials-missing', 'provider-credentials-missing')
    }
    if (typeof fetchImpl !== 'function') return fail('provider-unavailable', 'fetch-unavailable')

    try {
      const host = NETWORKS[network].host
      const headers = { 'content-type': 'application/json', 'x-api-key': env.TATUM_API_KEY.trim() }
      const tronWeb = await tronWebFactory(host, headers)
      if (!tronWeb.isAddress(sponsorAddress) || !tronWeb.isAddress(receiverAddress)) {
        return fail('invalid-request', 'invalid-tron-address')
      }
      const expectedOwner = normalizeAddress(tronWeb, sponsorAddress)
      const expectedReceiver = normalizeAddress(tronWeb, receiverAddress)
      const post = async (path, body) => {
        const response = await fetchImpl(host + path, {
          method: 'POST',
          redirect: 'error',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!response.ok) throw Object.assign(new Error('provider-http-error'), { status: response.status })
        const value = await response.json()
        if (!value || typeof value !== 'object' || Array.isArray(value) || value.Error) {
          throw Object.assign(new Error('invalid-provider-response'), { reason: 'invalid-provider-response' })
        }
        return value
      }
      const [transaction, info] = await Promise.all([
        post('/walletsolidity/gettransactionbyid', { value: transactionId.toLowerCase() }),
        post('/walletsolidity/gettransactioninfobyid', { value: transactionId.toLowerCase() }),
      ])
      if (!transaction.txID || transaction.txID.toLowerCase() !== transactionId.toLowerCase()
        || !info || Object.keys(info).length === 0 || !Number.isSafeInteger(info.blockNumber) || info.blockNumber <= 0) {
        return fail('pending-solidification', 'solidified-transaction-not-found')
      }
      const rawDataHex = typeof transaction.raw_data_hex === 'string' ? transaction.raw_data_hex : ''
      if (!/^(?:[0-9a-f]{2})+$/i.test(rawDataHex)
        || createHash('sha256').update(Buffer.from(rawDataHex, 'hex')).digest('hex') !== transactionId.toLowerCase()
        || typeof info.id !== 'string' || info.id.toLowerCase() !== transactionId.toLowerCase()) {
        return fail('solidified-transaction-identity-mismatch', 'solidified-transaction-id-not-bound-to-raw-data')
      }
      const contracts = transaction.raw_data?.contract
      const contract = Array.isArray(contracts) && contracts.length === 1
        && contracts[0]?.type === 'DelegateResourceContract' ? contracts[0] : null
      const value = contract?.parameter?.value
      const amount = numericText(value?.balance)
      const returnedResource = normalizeResource(value?.resource)
      const topLevelResult = typeof info.result === 'string' ? info.result.toUpperCase() : null
      const receiptResult = typeof info.receipt?.result === 'string' ? info.receipt.result.toUpperCase() : null
      const receiptFailed = topLevelResult === 'FAILED' || receiptResult === 'FAILED'
      const topLevelResultAcceptable = topLevelResult === null
        || ['SUCCESS', 'SUCESS'].includes(topLevelResult)
      const receiptResultAcceptable = receiptResult === null || receiptResult === 'SUCCESS'
      const executionSucceeded = Array.isArray(transaction.ret)
        && transaction.ret.length === 1
        && transaction.ret[0]?.contractRet === 'SUCCESS'
        && topLevelResultAcceptable
        && receiptResultAcceptable
      const exactTransaction = normalizeAddress(tronWeb, value?.owner_address) === expectedOwner
        && normalizeAddress(tronWeb, value?.receiver_address) === expectedReceiver
        && amount === stakeEquivalentSun
        && returnedResource === resourceType
        && value?.lock !== true
      if (!exactTransaction || !executionSucceeded || receiptFailed) {
        return fail('solidified-transaction-mismatch', 'solidified-delegation-mismatch', { blockNumber: info.blockNumber })
      }

      const delegationPayload = await post('/walletsolidity/getdelegatedresourcev2', {
        fromAddress: tronWeb.address.toHex(sponsorAddress),
        toAddress: tronWeb.address.toHex(receiverAddress),
        visible: false,
      })
      const rows = Array.isArray(delegationPayload.delegatedResource)
        ? delegationPayload.delegatedResource
        : (delegationPayload.from && delegationPayload.to ? [delegationPayload] : [])
      const balanceKey = resourceType === 'ENERGY' ? 'frozen_balance_for_energy' : 'frozen_balance_for_bandwidth'
      const expiryKey = resourceType === 'ENERGY' ? 'expire_time_for_energy' : 'expire_time_for_bandwidth'
      let actualDelegatedSun = 0n
      let matchingDelegationRows = 0
      const checkedAtMs = Date.now()
      for (const row of rows) {
        if (normalizeAddress(tronWeb, row?.from) !== expectedOwner
          || normalizeAddress(tronWeb, row?.to) !== expectedReceiver) continue
        matchingDelegationRows += 1
        const amountText = numericText(row?.[balanceKey])
        const expiryValue = row?.[expiryKey]
        const expiry = typeof expiryValue === 'number' ? expiryValue
          : typeof expiryValue === 'string' && INTEGER_PATTERN.test(expiryValue)
            ? Number(expiryValue) : Number.NaN
        if (amountText === null || !Number.isSafeInteger(expiry) || expiry < 0) {
          return fail('delegation-state-unavailable', 'delegation-resource-or-expiry-invalid', {
            transactionId: transactionId.toLowerCase(),
            blockNumber: info.blockNumber,
            resourceType,
          })
        }
        if (expiry === 0 || expiry > checkedAtMs) actualDelegatedSun += BigInt(amountText)
      }
      if (actualDelegatedSun < BigInt(stakeEquivalentSun)) {
        return fail('delegation-state-not-yet-confirmed', 'resulting-resource-allocation-mismatch', {
          transactionId: transactionId.toLowerCase(),
          blockNumber: info.blockNumber,
          resourceType,
          expectedStakeEquivalentSun: stakeEquivalentSun,
          observedStakeEquivalentSun: actualDelegatedSun.toString(),
          matchingDelegationRows,
        })
      }

      return {
        success: true,
        verified: true,
        status: 'solidified-resource-delegation-verified',
        network,
        transactionId: transactionId.toLowerCase(),
        sponsorAddress,
        receiverAddress,
        resourceType,
        stakeEquivalentSun,
        observedStakeEquivalentSun: actualDelegatedSun.toString(),
        matchingDelegationRows,
        blockNumber: info.blockNumber,
        checkedAt: new Date().toISOString(),
        source: 'Tatum SolidityNode solidified transaction and delegation-state queries',
        note: 'This verifies a resource delegation only. It does not prove a later token transfer is fee-free, transfer any token principal, or confirm exchange deposit credit.',
      }
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : null
      return fail(status === 401 || status === 403 ? 'provider-auth-rejected'
        : status ? 'provider-http-error' : 'provider-unreachable',
      status === 401 || status === 403 ? 'provider-auth-rejected'
        : status ? 'provider-http-error' : (error?.reason || 'provider-unreachable'),
      status ? { providerStatus: status } : {})
    }
  }
}
