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

/**
 * Simulates the exact TRC-20 transfer and estimates a conservative fee cap.
 * This performs read-only node calls only; no transaction is signed or sent.
 */
export async function estimateTRC20TransferFee({ tronWeb, from, to, tokenContract, amountBaseUnits }) {
  if (!tronWeb || typeof tronWeb !== 'object') throw new Error('TRON network connection is unavailable.')
  if (!canonicalBase58(tronWeb, from) || !canonicalBase58(tronWeb, to) || from === to) {
    throw new Error('Sender or recipient address is invalid.')
  }
  if (!canonicalBase58(tronWeb, tokenContract)) throw new Error('Select a valid TRC-20 contract.')
  if (typeof amountBaseUnits !== 'string' || !/^[1-9][0-9]{0,77}$/.test(amountBaseUnits)
    || BigInt(amountBaseUnits) > MAX_UINT256) throw new Error('Transfer amount must be a positive uint256 base-unit value.')

  const parameters = [
    { type: 'address', value: to },
    { type: 'uint256', value: amountBaseUnits },
  ]
  const simulation = await tronWeb.transactionBuilder.triggerConstantContract(
    tokenContract,
    'transfer(address,uint256)',
    {},
    parameters,
    from,
  )
  if (simulation?.result?.result !== true) {
    throw new Error('On-chain simulation did not succeed. No transfer was signed or submitted.')
  }
  const simulationContractResults = [
    simulation?.transaction?.ret?.[0]?.contractRet,
    simulation?.transaction?.ret?.[0]?.ret,
    simulation?.ret?.[0]?.contractRet,
  ].filter(value => value !== undefined && value !== null).map(value => String(value).toUpperCase())
  if (simulationContractResults.some(value => ['FAILED', 'OUT_OF_ENERGY', 'REVERT', 'REVERTED', 'FALSE'].includes(value))) {
    throw new Error('The TRC-20 simulation explicitly reported a failed execution. No transfer was signed or submitted.')
  }
  if (simulationContractResults.some(value => value === 'SUCCESS' || value === 'TRUE')) {
    // Explicit success evidence is useful when present; otherwise result.result
    // must be true and usable energy must be returned below.
  } else if (simulation?.transaction?.ret?.[0]?.contractRet !== undefined
    || simulation?.ret?.[0]?.contractRet !== undefined) {
    throw new Error('The TRC-20 simulation returned an unknown execution status. No transfer was signed or submitted.')
  }

  let energyRequired = Number(simulation.energy_used)
  try {
    const estimated = await tronWeb.transactionBuilder.estimateEnergy(
      tokenContract,
      'transfer(address,uint256)',
      {},
      parameters,
      from,
    )
    if (estimated?.result?.result === true && Number.isFinite(Number(estimated.energy_required)) && Number(estimated.energy_required) > 0) {
      energyRequired = Number(estimated.energy_required)
    }
  } catch {
    // estimateEnergy is optional; use triggerConstantContract's energy_used.
  }
  if (!Number.isSafeInteger(energyRequired) || energyRequired <= 0) {
    throw new Error('The network did not return a reliable energy estimate. No transfer was signed or submitted.')
  }

  const chainParameters = await tronWeb.trx.getChainParameters()
  const energyParameter = Array.isArray(chainParameters)
    ? chainParameters.find((item) => item?.key === 'getEnergyFee')
    : null
  const sunPerEnergy = Number(energyParameter?.value)
  if (!Number.isSafeInteger(sunPerEnergy) || sunPerEnergy <= 0) {
    throw new Error('The network energy price could not be read. No transfer was signed or submitted.')
  }

  // 20% energy headroom plus 1 TRX to allow for bandwidth and estimate variance.
  const recommendedFeeSun = Math.ceil(energyRequired * 1.2) * sunPerEnergy + 1_000_000
  if (!Number.isSafeInteger(recommendedFeeSun) || recommendedFeeSun > 100_000_000) {
    throw new Error('The estimated fee exceeds the wallet’s 100 TRX safety cap. No transfer was signed or submitted.')
  }
  return { energyRequired, sunPerEnergy, recommendedFeeSun, simulationSucceeded: true }
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

function normalizedHex(value) {
  return typeof value === 'string' ? value.replace(/^0x/i, '').toLowerCase() : ''
}

function expectedAddressHex(tronWeb, address) {
  try {
    const value = normalizedHex(tronWeb.address.toHex(address))
    return value
  } catch {
    return ''
  }
}

/** Reject a node-built transaction unless its unsigned intent exactly matches the user review. */
export function assertTransferTransactionIntent(tronWeb, transaction, { from, to, asset, amountBaseUnits, tokenContract }) {
  const contracts = transaction?.raw_data?.contract
  if (!Array.isArray(contracts) || contracts.length !== 1) {
    throw new Error('The built transaction contains unexpected contract operations. Signing was stopped.')
  }
  const contract = contracts[0]
  const value = contract?.parameter?.value
  if (transactionOwner(tronWeb, transaction) !== from) {
    throw new Error('Transaction sender does not match the unlocked wallet. Signing was stopped.')
  }
  const expectedTo = expectedAddressHex(tronWeb, to)
  if (!expectedTo) throw new Error('The reviewed recipient could not be encoded by the wallet SDK.')
  if (asset === 'TRX') {
    if (contract?.type !== 'TransferContract' || normalizedHex(value?.to_address) !== expectedTo) {
      throw new Error('The node-built transaction is not the reviewed TRX transfer. Signing was stopped.')
    }
    if (typeof value?.amount !== 'number' && typeof value?.amount !== 'string') {
      throw new Error('The built TRX transfer amount is missing. Signing was stopped.')
    }
    if (BigInt(String(value.amount)) !== BigInt(amountBaseUnits)) {
      throw new Error('The node-built TRX amount differs from the review. Signing was stopped.')
    }
    return true
  }
  if (asset !== 'TRC20' || !tokenContract || contract?.type !== 'TriggerSmartContract') {
    throw new Error('The node-built transaction has an unexpected contract type. Signing was stopped.')
  }
  const expectedContract = expectedAddressHex(tronWeb, tokenContract)
  if (!expectedContract || normalizedHex(value?.contract_address) !== expectedContract) {
    throw new Error('The node-built token contract differs from the selected contract. Signing was stopped.')
  }
  const recipientBytes = expectedTo.startsWith('41') ? expectedTo.slice(2) : expectedTo
  const contractBytes = expectedContract.startsWith('41') ? expectedContract.slice(2) : expectedContract
  if (!/^[0-9a-f]{40}$/.test(recipientBytes) || !/^[0-9a-f]{40}$/.test(contractBytes)) {
    throw new Error('The selected TRON address could not be encoded safely. Signing was stopped.')
  }
  const expectedData = 'a9059cbb'
    + recipientBytes.padStart(64, '0')
    + BigInt(amountBaseUnits).toString(16).padStart(64, '0')
  if (normalizedHex(value?.data) !== expectedData) {
    throw new Error('The node-built token recipient or amount differs from the review. Signing was stopped.')
  }
  return true
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
  assertTransferTransactionIntent(tronWeb, unsigned, { from, to, asset, amountBaseUnits, tokenContract })

  // Sign the returned transaction object only after validating its complete
  // operation, recipient, amount, and token contract. Never broadcast unsigned.
  const signed = await tronWeb.trx.sign(unsigned)
  if (!signed || !Array.isArray(signed.signature) || signed.signature.length < 1) {
    throw new Error('Transaction signing did not return a signature. Nothing was broadcast.')
  }
  assertTransferTransactionIntent(tronWeb, signed, { from, to, asset, amountBaseUnits, tokenContract })
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
      const executionResults = [
        confirmed?.ret?.[0]?.contractRet,
        info?.receipt?.result,
        info?.result,
      ].filter(value => typeof value === 'string' && value.length > 0).map(value => value.toUpperCase())
      const hasFailure = executionResults.some(value => ['FAILED', 'OUT_OF_ENERGY', 'REVERT', 'REVERTED'].includes(value))
      const hasSuccess = executionResults.some(value => value === 'SUCCESS')
      if (hasFailure) {
        return { status: 'failed', solidified: true, blockNumber: Number(info?.blockNumber || 0) || null }
      }
      if (hasSuccess) {
        return { status: 'confirmed', solidified: true, blockNumber: Number(info?.blockNumber || 0) || null }
      }
      // A solidified transaction object without explicit successful execution
      // evidence is not enough to claim the transfer succeeded.
      return { status: 'included-unconfirmed', solidified: false, blockNumber: Number(info?.blockNumber || 0) || null }
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
