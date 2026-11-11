/**
 * Fail-closed classification of incoming TRON Mainnet USDT deposit evidence.
 *
 * This is a pure, non-operational policy helper. It never writes a ledger,
 * sweeps funds, reserves balances, authorizes payouts, signs, or broadcasts.
 */
const MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const TX_ID = /^[0-9a-f]{64}$/i
const ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const UINT = /^(0|[1-9][0-9]*)$/

export function classifyIncomingUsdtDepositEvidence({
  expectedTreasuryAddress,
  event = {},
  proof = {},
} = {}) {
  const reasons = []
  const add = (ok, reason) => { if (!ok) reasons.push(reason) }
  const treasury = typeof expectedTreasuryAddress === 'string' ? expectedTreasuryAddress.trim() : ''
  const tx = typeof event.transactionHash === 'string' ? event.transactionHash.toLowerCase() : ''
  const from = typeof event.fromAddress === 'string' ? event.fromAddress : ''
  const to = typeof event.toAddress === 'string' ? event.toAddress : ''
  const amount = typeof event.amountBaseUnits === 'string' ? event.amountBaseUnits : ''
  const block = event.blockNumber
  const logIndex = event.logIndex

  add(event.network === 'TRON_MAINNET', 'network-not-tron-mainnet')
  add(ADDRESS.test(treasury), 'configured-treasury-address-invalid')
  add(ADDRESS.test(from), 'sender-address-invalid')
  add(to === treasury, 'deposit-destination-not-designated-treasury')
  add(event.tokenContract === MAINNET_USDT, 'token-contract-not-official-tron-usdt')
  add(event.decimals === 6, 'token-decimals-mismatch')
  add(TX_ID.test(tx), 'transaction-hash-invalid')
  add(UINT.test(amount) && amount !== '0', 'deposit-amount-invalid')
  add(Number.isSafeInteger(block) && block > 0, 'solidified-block-number-invalid')
  add(Number.isSafeInteger(logIndex) && logIndex >= 0, 'event-log-index-invalid')
  add(event.finality === 'solidified', 'deposit-not-solidified')
  add(proof.verified === true, 'independent-transfer-proof-missing')
  add(String(proof.transactionHash || '').toLowerCase() === tx, 'proof-transaction-mismatch')
  add(proof.contract === MAINNET_USDT, 'proof-token-contract-mismatch')
  add(proof.from === from, 'proof-sender-mismatch')
  add(proof.to === to, 'proof-recipient-mismatch')
  add(String(proof.amountBaseUnits ?? '') === amount, 'proof-amount-mismatch')
  add(Number(proof.blockNumber) === block, 'proof-block-mismatch')
  add(Number(proof.logIndex) === logIndex, 'proof-log-index-mismatch')

  const evidenceMatches = reasons.length === 0
  return Object.freeze({
    schema: 'tron-transfer.incoming-usdt-deposit-evidence.v1',
    status: evidenceMatches ? 'evidence-matches-designated-treasury' : 'blocked-unverified-deposit',
    evidenceMatches,
    reasons: Object.freeze(reasons),
    ledgerCreditAuthorized: false,
    automaticSweepAuthorized: false,
    spendableBalanceImpact: 'none',
    payoutAuthorizationGranted: false,
    executionEnabled: false,
  })
}
