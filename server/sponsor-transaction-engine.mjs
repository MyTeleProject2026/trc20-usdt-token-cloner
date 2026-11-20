import { TronWeb } from 'tronweb'

const MAINNET = 'https://api.trongrid.io'
const ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const TXID = /^[0-9a-f]{64}$/i
const SUN = 1_000_000n

function positiveSun(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,20}$/.test(value)) return null
  const amount = BigInt(value)
  return amount <= (1n << 63n) - 1n ? amount : null
}

function safeErrorCode(error) {
  const message = String(error?.message || '')
  if (/timeout|abort/i.test(message)) return 'provider-timeout'
  if (/balance|insufficient/i.test(message)) return 'insufficient-sponsor-balance'
  return 'sponsor-transaction-failed'
}

/**
 * Server-only Stake 2.0 transaction adapter.
 * Private key is read from the process environment at execution time and is
 * never returned, logged, persisted, or accepted from an HTTP request.
 */
export function createSponsorTransactionEngine({
  env = process.env,
  tronWebFactory = (privateKey) => new TronWeb({
    fullHost: MAINNET,
    privateKey,
    headers: env.TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': env.TRONGRID_API_KEY } : {},
  }),
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  function loadSigner() {
    const privateKey = env.SPONSOR_MAINNET_PRIVATE_KEY
    const expectedAddress = env.SPONSOR_MAINNET_ADDRESS
    if (typeof privateKey !== 'string' || !/^[0-9a-f]{64}$/i.test(privateKey)
      || !ADDRESS.test(expectedAddress || '')) throw new Error('sponsor-signer-not-configured')
    const tronWeb = tronWebFactory(privateKey)
    const derivedAddress = tronWeb.address.fromPrivateKey(privateKey)
    if (derivedAddress !== expectedAddress) throw new Error('sponsor-signer-address-mismatch')
    return { tronWeb, privateKey, sponsorAddress: derivedAddress }
  }

  async function verifySolidified(txid, sponsorAddress, ownerAddress, operation) {
    const response = await fetchImpl(MAINNET + '/walletsolidity/gettransactioninfobyid', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ value: txid }),
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) return { confirmed: false, status: 'solidified-provider-unavailable' }
    const info = await response.json()
    if (info?.id?.toLowerCase() !== txid.toLowerCase() || !Number.isSafeInteger(info.blockNumber) || info.blockNumber <= 0) {
      return { confirmed: false, status: 'not-solidified' }
    }
    if (info.receipt?.result !== 'SUCCESS') return { confirmed: false, status: 'solidified-execution-failed' }
    // Receipt alone is insufficient: read the solidified transaction body and
    // prove the contract type, owner and recipient match the authorized intent.
    const txResponse = await fetchImpl(MAINNET + '/walletsolidity/gettransactionbyid', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ value: txid }),
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    })
    if (!txResponse.ok) return { confirmed: false, status: 'solidified-transaction-unavailable' }
    const tx = await txResponse.json()
    if (tx?.txID?.toLowerCase() !== txid.toLowerCase()) return { confirmed: false, status: 'solidified-transaction-id-mismatch' }
    const contracts = tx.raw_data?.contract
    const expectedType = operation === 'stake' ? 'FreezeBalanceV2Contract' : 'DelegateResourceContract'
    if (!Array.isArray(contracts) || contracts.length !== 1 || contracts[0]?.type !== expectedType) {
      return { confirmed: false, status: 'solidified-operation-type-mismatch' }
    }
    const value = contracts[0]?.parameter?.value || {}
    const owner = value.owner_address
    let ownerBase58 = ''
    try { ownerBase58 = new TronWeb().address.fromHex(owner) } catch {}
    if (ownerBase58 !== sponsorAddress) return { confirmed: false, status: 'solidified-sponsor-owner-mismatch' }
    if (value.resource !== undefined && value.resource !== (operation === 'stake' ? (value.resource === 1 ? 'ENERGY' : value.resource === 0 ? 'BANDWIDTH' : value.resource) : value.resource)) return { confirmed: false, status: 'solidified-resource-type-mismatch' }
    if (operation === 'delegate' && value.receiver_address) {
      let recipient = ''
      try { recipient = new TronWeb().address.fromHex(value.receiver_address) } catch {}
      if (recipient !== ownerAddress) return { confirmed: false, status: 'solidified-recipient-mismatch' }
    }
    return { confirmed: true, status: 'solidified-success', blockNumber: info.blockNumber }
  }

  async function execute({ operation, amountSun, resource, ownerAddress, confirmPhrase } = {}) {
    if (env.SPONSOR_TRANSACTION_ENGINE_ENABLED !== 'true' || env.SPONSOR_MAINNET_BROADCAST_ENABLED !== 'true') {
      return { success: false, status: 'sponsor-transaction-engine-disabled', signed: false, broadcast: false }
    }
    if (!['stake', 'delegate'].includes(operation) || !['ENERGY', 'BANDWIDTH'].includes(resource)
      || !ADDRESS.test(ownerAddress || '') || confirmPhrase !== 'CONFIRM TRON MAINNET SPONSOR TRANSACTION') {
      return { success: false, status: 'invalid-or-unconfirmed-mainnet-intent', signed: false, broadcast: false }
    }
    const amount = positiveSun(amountSun)
    if (!amount || amount < SUN) return { success: false, status: 'invalid-amount-sun', signed: false, broadcast: false }
    let signer
    try {
      signer = loadSigner()
      if (signer.sponsorAddress === ownerAddress) return { success: false, status: 'sponsor-owner-wallets-must-be-independent', signed: false, broadcast: false }
      const { tronWeb, privateKey, sponsorAddress } = signer
      if (operation === 'stake') {
        const balanceSun = BigInt(await tronWeb.trx.getBalance(sponsorAddress))
        const reserveTrx = typeof env.SPONSOR_LIQUID_RESERVE_TRX === 'string' ? env.SPONSOR_LIQUID_RESERVE_TRX : '2'
        if (!/^(0|[1-9][0-9]*)(?:\\.[0-9]{1,6})?$/.test(reserveTrx)) return { success: false, status: 'invalid-protected-reserve-policy', signed: false, broadcast: false }
        const [whole, fraction = ''] = reserveTrx.split('.')
        const reserve = BigInt(whole) * SUN + BigInt((fraction + '000000').slice(0, 6))
        if (balanceSun < amount + reserve) return { success: false, status: 'insufficient-balance-after-protected-reserve', signed: false, broadcast: false }
      } else {
        // A delegation consumes already-frozen Stake 2.0 capacity, not liquid TRX.
        // Ask the Mainnet node for the maximum currently delegatable amount.
        const maximum = await tronWeb.trx.getCanDelegatedMaxSize(sponsorAddress, resource)
        if (BigInt(String(maximum)) < amount) return { success: false, status: 'insufficient-frozen-resource-to-delegate', signed: false, broadcast: false }
      }
      const transaction = operation === 'stake'
        ? await tronWeb.transactionBuilder.freezeBalanceV2(amount.toString(), resource, sponsorAddress)
        : await tronWeb.transactionBuilder.delegateResource(amount.toString(), ownerAddress, resource, false, 0, sponsorAddress)
      if (!transaction?.txID || !transaction?.raw_data_hex) return { success: false, status: 'unsigned-transaction-invalid', signed: false, broadcast: false }
      const signed = await tronWeb.trx.sign(transaction, privateKey)
      if (!signed?.signature?.length || signed.txID !== transaction.txID) return { success: false, status: 'signed-transaction-integrity-failed', signed: false, broadcast: false }
      // Never persist or return the signed transaction or signature.
      const broadcast = await tronWeb.trx.sendRawTransaction(signed)
      if (broadcast?.result !== true) {
        return { success: false, status: 'broadcast-rejected-or-unknown', txid: signed.txID, signed: true, broadcast: false }
      }
      const verification = await verifySolidified(signed.txID, sponsorAddress, ownerAddress, operation)
      return {
        success: verification.confirmed,
        status: verification.status,
        txid: signed.txID,
        blockNumber: verification.blockNumber ?? null,
        sponsorAddress,
        ownerAddress: operation === 'delegate' ? ownerAddress : undefined,
        operation,
        resource,
        amountSun: amount.toString(),
        signed: true,
        broadcast: true,
        solidified: verification.confirmed,
        checkedAt: new Date(now()).toISOString(),
      }
    } catch (error) {
      return { success: false, status: safeErrorCode(error), signed: false, broadcast: false }
    } finally {
      signer = null
    }
  }

  return Object.freeze({ execute })
}
