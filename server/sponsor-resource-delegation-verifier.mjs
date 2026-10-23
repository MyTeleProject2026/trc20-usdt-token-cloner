const NETWORKS = Object.freeze({
  mainnet: { host: 'https://tron-mainnet.gateway.tatum.io' },
  shasta: { host: 'https://tron-shasta.gateway.tatum.io' },
  nile: { host: 'https://tron-nile.gateway.tatum.io' },
})
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
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
  fetchImpl = globalThis.fetch,
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
      || typeof sponsorAddress !== 'string' || !ADDRESS_PATTERN.test(sponsorAddress)
      || typeof receiverAddress !== 'string' || !ADDRESS_PATTERN.test(receiverAddress)
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
      const contract = transaction.raw_data?.contract?.find((entry) => entry?.type === 'DelegateResourceContract')
      const value = contract?.parameter?.value
      const amount = numericText(value?.balance)
      const returnedResource = normalizeResource(value?.resource)
      const receiptFailed = String(info.result || '').toUpperCase() === 'FAILED'
        || String(info.receipt?.result || '').toUpperCase() === 'FAILED'
      const executionSucceeded = transaction.ret?.[0]?.contractRet === 'SUCCESS'
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
      const actualDelegatedSun = rows
        .filter((row) => normalizeAddress(tronWeb, row.from) === expectedOwner
          && normalizeAddress(tronWeb, row.to) === expectedReceiver)
        .reduce((total, row) => {
          const amountText = numericText(row[balanceKey])
          return amountText === null ? total : total + BigInt(amountText)
        }, 0n)
      if (actualDelegatedSun < BigInt(stakeEquivalentSun)) {
        return fail('delegation-state-not-yet-confirmed', 'resulting-resource-allocation-mismatch', {
          transactionId: transactionId.toLowerCase(),
          blockNumber: info.blockNumber,
          resourceType,
          expectedStakeEquivalentSun: stakeEquivalentSun,
          observedStakeEquivalentSun: actualDelegatedSun.toString(),
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
