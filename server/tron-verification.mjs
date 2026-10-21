const TX_ID = /^[0-9a-f]{64}$/i
const HEX_ADDRESS = /^(?:41)?[0-9a-f]{40}$/i
const TRANSFER_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

function normalizeAddress(value) {
  if (typeof value !== 'string') return null
  const hex = value.replace(/^0x/i, '')
  if (!HEX_ADDRESS.test(hex)) return null
  return (hex.length === 42 && /^41/i.test(hex) ? hex.slice(2) : hex).toLowerCase()
}

function topicAddress(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) return null
  return normalizeAddress(value.slice(-40))
}

/**
 * Verifies a TRC-20 Transfer event against a transaction body and receipt
 * obtained from TRON's SolidityNode (walletsolidity endpoints).
 *
 * All expected addresses must be hex form (20-byte address, optionally
 * prefixed with TRON's 41 network byte). This function makes no network
 * requests and does not treat indexer history or a broadcast response as proof.
 */
export function verifySolidifiedTrc20Transfer({
  transaction,
  receipt,
  expectedTxId,
  tokenContractAddress,
  fromAddress,
  toAddress,
  amountSun,
}) {
  const fail = (reason) => ({ verified: false, reason })
  if (typeof expectedTxId !== 'string' || !TX_ID.test(expectedTxId)) return fail('invalid-expected-transaction-id')
  if (!transaction || String(transaction.txID || '').toLowerCase() !== expectedTxId.toLowerCase()) return fail('solidified-transaction-not-found-or-id-mismatch')
  const contractResults = Array.isArray(transaction.ret) ? transaction.ret : []
  if (contractResults.some((entry) => entry?.contractRet && entry.contractRet !== 'SUCCESS')) return fail('transaction-contract-execution-not-successful')
  if (!receipt || String(receipt.id || '').toLowerCase() !== expectedTxId.toLowerCase()) return fail('solidified-receipt-not-found-or-id-mismatch')
  if (!Number.isFinite(Number(receipt.blockNumber)) || Number(receipt.blockNumber) <= 0) return fail('receipt-has-no-solidified-block')
  if (receipt.result === 'FAILED' || receipt.receipt?.result !== 'SUCCESS') return fail('contract-execution-not-successful')
  const contract = normalizeAddress(tokenContractAddress)
  const from = normalizeAddress(fromAddress)
  const to = normalizeAddress(toAddress)
  if (!contract || !from || !to) return fail('invalid-expected-address')
  let amount
  try {
    amount = BigInt(amountSun)
    if (amount <= 0n) return fail('invalid-expected-amount')
  } catch {
    return fail('invalid-expected-amount')
  }
  const logs = Array.isArray(receipt.log) ? receipt.log : []
  const matchingLogIndex = logs.findIndex((log) => {
    if (normalizeAddress(log?.address) !== contract) return false
    const topics = Array.isArray(log.topics) ? log.topics : []
    if (String(topics[0] || '').replace(/^0x/i, '').toLowerCase() !== TRANSFER_TOPIC) return false
    if (topicAddress(topics[1]) !== from || topicAddress(topics[2]) !== to) return false
    const data = typeof log.data === 'string' ? log.data.replace(/^0x/i, '') : ''
    if (!/^[0-9a-f]{64}$/i.test(data)) return false
    try { return BigInt('0x' + data) === amount } catch { return false }
  })
  if (matchingLogIndex < 0) return fail('matching-transfer-event-not-found')
  return {
    verified: true,
    txId: expectedTxId.toLowerCase(),
    blockNumber: Number(receipt.blockNumber),
    logIndex: matchingLogIndex,
    tokenContractAddress,
    fromAddress,
    toAddress,
    amountSun: amount.toString(),
    confirmationSource: 'solidified-transaction-body-and-receipt',
  }
}
