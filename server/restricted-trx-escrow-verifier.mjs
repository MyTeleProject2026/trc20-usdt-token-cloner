/**
 * Strict verifier for a real TRON native-TRX escrow funding transaction.
 * This module reads evidence only; it never signs, broadcasts, or credits a
 * Bitpie wallet. It binds txid -> contract call -> event -> request ID ->
 * beneficiary position -> aggregate collateral.
 */
import { TronWeb } from 'tronweb'

const HEX = /^[0-9a-f]{64}$/i
const BASE58 = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const FUND_SELECTOR = TronWeb.sha3('fundPosition(bytes32,address,uint64)').slice(0, 10).toLowerCase()
const FUND_EVENT_TOPIC = TronWeb.sha3('PositionFunded(bytes32,address,uint256,uint64)').toLowerCase()

function fail(reason) {
  return Object.freeze({ verified: false, reason, creditableAmountSun: '0' })
}

function cleanHex(value) {
  return String(value || '').replace(/^0x/i, '').toLowerCase()
}

function normalizeTronHexAddress(value) {
  const hex = cleanHex(value)
  if (!/^(41)?[0-9a-f]{40}$/i.test(hex)) return null
  return hex.startsWith('41') ? hex.slice(2) : hex
}

function decodeAddressWord(value) {
  const word = cleanHex(value)
  if (!/^[0-9a-f]{64}$/i.test(word) || !/^0{24}/i.test(word)) return null
  return word.slice(24)
}

function addressHex(value) {
  try {
    if (BASE58.test(String(value || ''))) return normalizeTronHexAddress(TronWeb.address.toHex(value))
    return normalizeTronHexAddress(value)
  } catch {
    return null
  }
}

function asUint(value) {
  try {
    if (typeof value === 'bigint') return value >= 0n ? value : null
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) return null
    const text = String(value)
    if (!/^(0|[1-9][0-9]*)$/.test(text)) return null
    return BigInt(text)
  } catch {
    return null
  }
}

/**
 * Evidence is supplied by a trusted solidified-node reader plus contract view
 * calls. A success result is only valid if every on-chain field agrees.
 */
export function verifyRestrictedTrxEscrowEvidence({
  expectedRequestId,
  expectedBeneficiary,
  expectedContract,
  expectedProvider,
  transaction,
  receipt,
  position,
  providerAddress,
  contractBalanceSun,
  totalLockedLiabilitiesSun,
}) {
  const requestId = cleanHex(expectedRequestId)
  const beneficiaryHex = addressHex(expectedBeneficiary)
  const contractHex = addressHex(expectedContract)
  const configuredProviderHex = addressHex(expectedProvider || providerAddress)

  if (!HEX.test(requestId)) return fail('invalid-request-id')
  if (!beneficiaryHex || !contractHex || !configuredProviderHex) return fail('invalid-or-unchecksummed-address')
  if (expectedContractHex && normalizeTronHexAddress(expectedContractHex) !== contractHex) return fail('configured-contract-address-mismatch')
  if (!transaction || !receipt || !position) return fail('missing-solidified-evidence')

  const txid = cleanHex(transaction.txID || transaction.txid)
  if (!HEX.test(txid)) return fail('missing-transaction-id')
  if (expectedTxId && cleanHex(expectedTxId) !== txid) return fail('requested-transaction-id-mismatch')
  if (cleanHex(receipt.id) && cleanHex(receipt.id) !== txid) return fail('receipt-transaction-mismatch')
  if (!Number.isSafeInteger(Number(receipt.blockNumber)) || Number(receipt.blockNumber) <= 0) return fail('transaction-not-solidified')
  if (receipt.receipt?.result !== 'SUCCESS') return fail('contract-execution-failed')

  const contracts = transaction.raw_data?.contract || []
  const calls = contracts.filter((item) => item.type === 'TriggerSmartContract')
  if (calls.length !== 1 || contracts.length !== 1) return fail('unexpected-transaction-contracts')
  const value = calls[0].parameter?.value || calls[0].parameter?.Value || {}
  if (addressHex(value.contract_address) !== contractHex) return fail('escrow-contract-mismatch')
  if (addressHex(value.owner_address) !== configuredProviderHex) return fail('provider-sender-mismatch')

  const callValue = asUint(value.call_value)
  if (callValue === null || callValue <= 0n) return fail('missing-native-trx-call-value')

  const calldata = cleanHex(value.data)
  if (calldata.length < 8 + 64 * 3 || !calldata.startsWith(FUND_SELECTOR.slice(2))) {
    return fail('not-a-fund-position-call')
  }
  const callRequestId = calldata.slice(8, 72)
  const callBeneficiary = decodeAddressWord(calldata.slice(72, 136))
  if (callRequestId !== requestId) return fail('request-id-calldata-mismatch')
  if (callBeneficiary !== beneficiaryHex) return fail('beneficiary-calldata-mismatch')

  const logs = Array.isArray(receipt.log) ? receipt.log : []
  const event = logs.find((log) => {
    const topics = Array.isArray(log.topics) ? log.topics.map(cleanHex) : []
    return normalizeTronHexAddress(log.address) === contractHex
      && topics[0] === cleanHex(FUND_EVENT_TOPIC)
      && topics[1] === requestId
  })
  if (!event) return fail('position-funded-event-not-found')

  const eventTopics = event.topics.map(cleanHex)
  if (eventTopics.length !== 3 || decodeAddressWord(eventTopics[2]) !== beneficiaryHex) {
    return fail('event-beneficiary-mismatch')
  }
  const eventData = cleanHex(event.data)
  if (!/^[0-9a-f]{128}$/i.test(eventData)) return fail('invalid-position-event-data')
  const eventAmount = BigInt('0x' + eventData.slice(0, 64))
  const eventUnlockAt = BigInt('0x' + eventData.slice(64, 128))

  const positionBeneficiaryHex = addressHex(position.beneficiary)
  const positionAmount = asUint(position.amountSun)
  const positionUnlockAt = asUint(position.unlockAt)
  const claimed = Boolean(position.claimed)
  if (positionBeneficiaryHex !== beneficiaryHex) return fail('beneficiary-mismatch')
  if (positionAmount === null || positionAmount <= 0n || claimed || positionUnlockAt === null || positionUnlockAt <= 0n) {
    return fail('invalid-or-claimed-position')
  }
  if (callValue !== positionAmount || eventAmount !== positionAmount) return fail('principal-amount-mismatch')
  if (eventUnlockAt !== positionUnlockAt) return fail('unlock-time-mismatch')

  const contractBalance = asUint(contractBalanceSun)
  const liabilities = asUint(totalLockedLiabilitiesSun)
  if (contractBalance === null || liabilities === null) return fail('missing-contract-collateral-data')
  if (liabilities < positionAmount) return fail('locked-liabilities-below-position')
  if (contractBalance < liabilities) return fail('under-collateralized-escrow')

  return Object.freeze({
    verified: true,
    reason: 'solidified-transaction-event-position-and-collateral-verified',
    transactionId: txid,
    blockNumber: Number(receipt.blockNumber),
    beneficiary: expectedBeneficiary,
    escrowContract: expectedContract,
    requestId: '0x' + requestId,
    amountSun: positionAmount.toString(),
    contractBalanceSun: contractBalance.toString(),
    totalLockedLiabilitiesSun: liabilities.toString(),
    unlockAt: Number(positionUnlockAt),
    claimed,
    creditableAmountSun: positionAmount.toString(),
    explorerTransactionUrl: 'https://tronscan.org/#/transaction/' + txid,
    explorerContractUrl: 'https://tronscan.org/#/address/' + expectedContract,
    note: 'Verified contract-held TRX only. This is not an ordinary Bitpie wallet balance or Bitpie deposit notification.',
  })
}
