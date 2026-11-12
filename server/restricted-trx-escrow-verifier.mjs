/**
 * Fail-closed reconciliation for a real TRON native-TRX escrow position.
 * This module verifies supplied solidified chain reads; it never signs,
 * broadcasts, credits an external wallet, or manufactures a balance.
 */
const HEX = /^[0-9a-f]{64}$/i
const BASE58 = /^T[1-9A-HJ-NP-Za-km-z]{33}$/

function fail(reason) {
  return Object.freeze({ verified: false, reason, creditableAmountSun: '0' })
}

export function verifyRestrictedTrxEscrowEvidence({
  expectedRequestId,
  expectedBeneficiary,
  expectedContract,
  transaction,
  receipt,
  position,
  contractBalanceSun,
  totalLockedLiabilitiesSun,
}) {
  if (typeof expectedRequestId !== 'string' || !/^0x[0-9a-f]{64}$/i.test(expectedRequestId)) return fail('invalid-request-id')
  if (!BASE58.test(expectedBeneficiary || '') || !BASE58.test(expectedContract || '')) return fail('invalid-address')
  if (!transaction || !receipt || !position) return fail('missing-solidified-evidence')
  const txid = transaction.txID || transaction.txid
  if (typeof txid !== 'string' || !HEX.test(txid)) return fail('missing-transaction-id')
  if (receipt.id && receipt.id.toLowerCase() !== txid.toLowerCase()) return fail('receipt-transaction-mismatch')
  if (!Number.isSafeInteger(Number(receipt.blockNumber)) || Number(receipt.blockNumber) <= 0) return fail('transaction-not-solidified')
  if (receipt.receipt?.result !== 'SUCCESS' && receipt.result !== 'SUCCESS') return fail('contract-execution-failed')
  const contracts = transaction.raw_data?.contract || []
  const nativeCall = contracts.find((item) => item.type === 'TriggerSmartContract')
  if (!nativeCall) return fail('not-a-native-trx-contract-call')
  const value = nativeCall.parameter?.value || nativeCall.parameter?.Value || {}
  const destination = value.contract_address
  const amount = BigInt(String(value.call_value ?? 0))
  if (!destination || !Number.isSafeInteger(Number(amount)) || amount <= 0n) return fail('missing-native-trx-call-value')
  const positionBeneficiary = position.beneficiary
  const positionAmount = BigInt(String(position.amountSun ?? 0))
  const unlockAt = Number(position.unlockAt ?? 0)
  const claimed = Boolean(position.claimed)
  if (positionBeneficiary !== expectedBeneficiary) return fail('beneficiary-mismatch')
  if (positionAmount <= 0n || claimed || !Number.isSafeInteger(unlockAt) || unlockAt <= 0) return fail('invalid-or-claimed-position')
  const contractBalance = BigInt(String(contractBalanceSun ?? -1))
  const liabilities = BigInt(String(totalLockedLiabilitiesSun ?? -1))
  if (contractBalance < 0n || liabilities < 0n) return fail('missing-contract-collateral-data')
  if (contractBalance < liabilities) return fail('under-collateralized-escrow')
  return Object.freeze({
    verified: true,
    reason: 'solidified-evidence-and-collateral-checks-passed',
    transactionId: txid,
    beneficiary: positionBeneficiary,
    requestId: expectedRequestId,
    amountSun: positionAmount.toString(),
    contractBalanceSun: contractBalance.toString(),
    totalLockedLiabilitiesSun: liabilities.toString(),
    unlockAt,
    claimed,
    creditableAmountSun: positionAmount.toString(),
    note: 'Verified escrow-held position only. This does not create a Bitpie wallet-app balance or authorize withdrawal.',
  })
}
