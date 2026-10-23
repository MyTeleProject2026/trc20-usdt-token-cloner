import { verifySolidifiedTrc20Transfer } from './tron-verification.mjs'

const SOLIDIFIED_HOSTS = Object.freeze({
  mainnet: 'https://api.trongrid.io',
  nile: 'https://nile.trongrid.io',
})
const TX_ID = /^[0-9a-f]{64}$/i
const POSITIVE_INTEGER = /^[1-9][0-9]{0,77}$/

/**
 * Independently verifies a GasFree provider trace against TRON SolidityNode
 * transaction + receipt data. The provider's trace is only a locator; it is
 * never accepted as finality evidence by itself.
 *
 * @param {object} options
 * @param {typeof fetch} [options.fetchImpl]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {(host: string) => Promise<object>} [options.tronWebFactory]
 */
export function createGasFreeChainVerifier({
  fetchImpl = globalThis.fetch,
  env = process.env,
  tronWebFactory = async (host) => {
    const { TronWeb } = await import('tronweb')
    return new TronWeb({ fullHost: host })
  },
} = {}) {
  return async function verifyGasFreeTraceOnChain({ network, trace } = {}) {
    const notVerified = (status, reason) => ({
      verified: false,
      status,
      reason,
      source: 'TRON SolidityNode transaction body and receipt',
    })

    const host = SOLIDIFIED_HOSTS[network]
    if (!host) return notVerified('unsupported-network', 'unsupported-network')
    if (typeof fetchImpl !== 'function') return notVerified('verification-unavailable', 'fetch-unavailable')
    if (!trace || typeof trace !== 'object' || typeof trace.transactionId !== 'string'
      || !TX_ID.test(trace.transactionId)) {
      return notVerified('awaiting-transaction-id', 'provider-trace-has-no-transaction-id')
    }
    if (typeof trace.tokenAddress !== 'string'
      || typeof trace.gasFreeAddress !== 'string'
      || typeof trace.receiverAddress !== 'string'
      || typeof trace.amountBaseUnits !== 'string'
      || !POSITIVE_INTEGER.test(trace.amountBaseUnits)) {
      return notVerified('incomplete-provider-trace', 'required-transfer-fields-missing')
    }

    try {
      const tronWeb = await tronWebFactory(host)
      const addresses = [trace.tokenAddress, trace.gasFreeAddress, trace.receiverAddress]
      if (typeof tronWeb?.isAddress !== 'function'
        || addresses.some((address) => !tronWeb.isAddress(address))
        || typeof tronWeb?.address?.toHex !== 'function') {
        return notVerified('incomplete-provider-trace', 'invalid-trace-address')
      }

      const [tokenContractAddress, fromAddress, toAddress] = addresses.map((address) => tronWeb.address.toHex(address))
      const headers = { 'content-type': 'application/json' }
      if (typeof env.TRONGRID_API_KEY === 'string' && env.TRONGRID_API_KEY.trim()) {
        headers['TRON-PRO-API-KEY'] = env.TRONGRID_API_KEY.trim()
      }

      async function querySolidified(path) {
        const response = await fetchImpl(host + path, {
          method: 'POST',
          headers,
          body: JSON.stringify({ value: trace.transactionId, visible: false }),
          signal: AbortSignal.timeout(8000),
        })
        if (!response.ok) throw new Error('solidified-provider-unavailable')
        return response.json()
      }

      const transaction = await querySolidified('/walletsolidity/gettransactionbyid')
      if (!transaction || transaction.txID?.toLowerCase() !== trace.transactionId.toLowerCase()) {
        return {
          ...notVerified('awaiting-solidification', 'solidified-transaction-not-yet-available'),
          network,
          transactionId: trace.transactionId.toLowerCase(),
        }
      }

      const receipt = await querySolidified('/walletsolidity/gettransactioninfobyid')
      if (!receipt || receipt.id?.toLowerCase() !== trace.transactionId.toLowerCase()) {
        return {
          ...notVerified('awaiting-solidified-receipt', 'solidified-receipt-not-yet-available'),
          network,
          transactionId: trace.transactionId.toLowerCase(),
        }
      }

      const result = verifySolidifiedTrc20Transfer({
        transaction,
        receipt,
        expectedTxId: trace.transactionId,
        tokenContractAddress,
        fromAddress,
        toAddress,
        amountSun: trace.amountBaseUnits,
      })
      if (!result.verified) {
        return {
          ...notVerified('not-verified', result.reason || 'solidified-transfer-mismatch'),
          network,
          transactionId: trace.transactionId.toLowerCase(),
          tokenContractAddress,
          fromAddress,
          toAddress,
          amountSun: trace.amountBaseUnits,
        }
      }

      return {
        ...result,
        network,
        status: 'verified-on-chain',
        source: 'TRON SolidityNode transaction body and receipt',
      }
    } catch {
      // Do not log addresses, provider responses, API keys, or request headers.
      return notVerified('verification-unavailable', 'solidified-provider-unavailable')
    }
  }
}

export default createGasFreeChainVerifier()
