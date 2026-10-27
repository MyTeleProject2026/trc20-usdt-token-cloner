const TX_ID_PATTERN = /^[0-9a-f]{64}$/i
const TRON_ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const MAX_UINT256 = (1n << 256n) - 1n

export function parseUnitsDecimal(value, decimals) {
  if (typeof value !== 'string' || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error('Enter a valid decimal amount for this token.')
  }
  const raw = value.trim()
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(raw)) {
    throw new Error('Amount must be a positive ordinary decimal number (no commas or scientific notation).')
  }
  const [whole, fraction = ''] = raw.split('.')
  if (fraction.length > decimals) {
    throw new Error(`This asset supports at most ${decimals} decimal places.`)
  }
  const joined = (whole + fraction.padEnd(decimals, '0')).replace(/^0+(?=\d)/, '')
  const units = BigInt(joined || '0')
  if (units <= 0n) throw new Error('Amount must be greater than zero.')
  if (units > MAX_UINT256) throw new Error('Amount is larger than the TRON token standard supports.')
  return units.toString()
}

function canonicalBase58(tronWeb, address) {
  try {
    return typeof address === 'string' && TRON_ADDRESS_PATTERN.test(address)
      && tronWeb.isAddress(address) ? address : null
  } catch {
    return null
  }
}

function transactionOwner(tronWeb, transaction) {
  const value = transaction?.raw_data?.contract?.[0]?.parameter?.value?.owner_address
  if (typeof value !== 'string') return null
  try {
    const base58 = tronWeb.address.fromHex(value.startsWith('0x') ? value.slice(2) : value)
    return canonicalBase58(tronWeb, base58)
  } catch {
    return null
  }
}

/**
 * Builds an unsigned transaction, signs it locally, and broadcasts only the
 * signed transaction. No private key is sent to a server. This function does
 * not call an exchange API or synthesize an account credit.
 */
export async function buildSignAndBroadcastTransfer({
  tronWeb,
  from,
  to,
  asset,
  amountBaseUnits,
  tokenContract,
  feeLimitSun = 50_000_000,
}) {
  if (!tronWeb || typeof tronWeb !== 'object') throw new Error('TRON network connection is unavailable.')
  if (!canonicalBase58(tronWeb, from)) throw new Error('The unlocked sender address is invalid.')
  if (!canonicalBase58(tronWeb, to)) throw new Error('The recipient is not a valid TRON Base58Check address.')
  if (from === to) throw new Error('Sender and recipient must be different addresses.')
  if (!['TRX', 'TRC20'].includes(asset)) throw new Error('Unsupported transfer asset.')
  if (typeof amountBaseUnits !== 'string' || !/^[1-9][0-9]{0,77}$/.test(amountBaseUnits)
    || BigInt(amountBaseUnits) > MAX_UINT256) throw new Error('Transfer amount must be a positive uint256 base-unit value.')
  if (!Number.isSafeInteger(feeLimitSun) || feeLimitSun < 1_000_000 || feeLimitSun > 100_000_000) {
    throw new Error('TRC-20 fee cap must be between 1 and 100 TRX.')
  }

  let unsigned
  if (asset === 'TRX') {
    const sun = BigInt(amountBaseUnits)
    if (sun > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('TRX amount is too large to represent safely.')
    unsigned = await tronWeb.transactionBuilder.sendTrx(to, Number(sun), from)
  } else {
    if (!canonicalBase58(tronWeb, tokenContract)) throw new Error('Select a verified TRC-20 contract before transfer.')
    const built = await tronWeb.transactionBuilder.triggerSmartContract(
      tokenContract,
      'transfer(address,uint256)',
      { feeLimit: feeLimitSun, callValue: 0 },
      [
        { type: 'address', value: to },
        { type: 'uint256', value: amountBaseUnits },
      ],
      from,
    )
    if (built?.result?.result !== true || !built?.transaction) {
      throw new Error('The TRC-20 transfer could not be built by the selected network. No transaction was signed or broadcast.')
    }
    unsigned = built.transaction
  }

  if (!unsigned?.txID || !Array.isArray(unsigned?.raw_data?.contract) || unsigned.raw_data.contract.length !== 1) {
    throw new Error('The network returned an unexpected transaction structure. Nothing was signed or broadcast.')
  }
  const owner = transactionOwner(tronWeb, unsigned)
  if (owner !== from) throw new Error('Transaction sender does not match the unlocked wallet. Signing was stopped.')

  // Sign the returned transaction object. Never broadcast the unsigned object.
  const signed = await tronWeb.trx.sign(unsigned)
  if (!signed || !Array.isArray(signed.signature) || signed.signature.length < 1) {
    throw new Error('Transaction signing did not return a signature. Nothing was broadcast.')
  }
  if (transactionOwner(tronWeb, signed) !== from) {
    throw new Error('Signed transaction sender mismatch. Broadcasting was stopped.')
  }
  if (signed.txID !== unsigned.txID) {
    throw new Error('Transaction ID changed unexpectedly during signing. Broadcasting was stopped.')
  }

  const result = await tronWeb.trx.sendRawTransaction(signed)
  if (result?.result !== true) {
    const code = typeof result?.code === 'string' ? result.code : ''
    const message = code === 'BANDWITH_ERROR' ? 'The network rejected the transfer because of insufficient bandwidth.' : 'The network did not accept the signed transfer for broadcast.'
    const error = new Error(message)
    error.code = code || 'broadcast-rejected'
    throw error
  }
  const txid = String(result.txid || result.txID || result.transaction?.txID || signed.txID || '')
  if (!TX_ID_PATTERN.test(txid)) {
    throw new Error('The broadcast response did not include a valid transaction ID. Check the chain explorer before retrying.')
  }
  return {
    txid: txid.toLowerCase(),
    network: 'confirmed-by-broadcast-node',
    source: from,
    destination: to,
    asset,
    tokenContract: asset === 'TRC20' ? tokenContract : null,
    amountBaseUnits,
  }
}

export async function readConfirmedTransferStatus(tronWeb, transactionId) {
  if (!tronWeb || typeof tronWeb !== 'object' || typeof transactionId !== 'string' || !TX_ID_PATTERN.test(transactionId)) {
    throw new Error('A valid transaction ID and TRON network connection are required.')
  }
  try {
    const [confirmed, info] = await Promise.all([
      tronWeb.trx.getConfirmedTransaction(transactionId),
      tronWeb.trx.getTransactionInfo(transactionId),
    ])
    const matched = String(confirmed?.txID || confirmed?.txid || '').toLowerCase() === transactionId.toLowerCase()
    if (matched) {
      const contractResult = String(confirmed?.ret?.[0]?.contractRet || info?.result || info?.receipt?.result || '').toUpperCase()
      if (contractResult === 'FAILED' || contractResult === 'OUT_OF_ENERGY') {
        return { status: 'failed', solidified: true, blockNumber: Number(info?.blockNumber || 0) || null }
      }
      if (contractResult === 'SUCCESS' || info?.receipt?.result === 'SUCCESS') {
        return { status: 'confirmed', solidified: true, blockNumber: Number(info?.blockNumber || 0) || null }
      }
      return { status: 'confirmed', solidified: true, blockNumber: Number(info?.blockNumber || 0) || null }
    }
  } catch {
    // The solidified node may not have indexed this transaction yet; check the
    // full node below to distinguish pending from a confirmed lookup failure.
  }
  try {
    const pending = await tronWeb.trx.getTransaction(transactionId)
    if (String(pending?.txID || pending?.txid || '').toLowerCase() === transactionId.toLowerCase()) {
      return { status: 'included-unconfirmed', solidified: false, blockNumber: null }
    }
  } catch {
    // Do not infer failure merely because one public node is temporarily down.
  }
  return { status: 'pending-or-not-indexed', solidified: false, blockNumber: null }
}
