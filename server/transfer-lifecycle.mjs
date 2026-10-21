// Pure transfer lifecycle rules. This module records evidence states only; it does
// not submit transactions or assert exchange credit without receiver-side evidence.
export const TRANSFER_STATUSES = Object.freeze([
  'draft',
  'awaiting-wallet-signature',
  'submitted',
  'awaiting-finality',
  'verified-on-chain',
  'receiver-balance-observed',
  'exchange-credit-confirmed',
  'failed',
  'inconclusive',
]);

const transitions = Object.freeze({
  draft: ['awaiting-wallet-signature', 'failed'],
  'awaiting-wallet-signature': ['submitted', 'failed', 'inconclusive'],
  submitted: ['awaiting-finality', 'failed', 'inconclusive'],
  'awaiting-finality': ['verified-on-chain', 'failed', 'inconclusive'],
  'verified-on-chain': ['receiver-balance-observed', 'inconclusive'],
  'receiver-balance-observed': ['exchange-credit-confirmed', 'inconclusive'],
  'exchange-credit-confirmed': [],
  failed: [],
  inconclusive: ['awaiting-finality', 'verified-on-chain', 'receiver-balance-observed'],
});

export function canTransitionTransferStatus(from, to, evidence = {}) {
  if (!TRANSFER_STATUSES.includes(from) || !TRANSFER_STATUSES.includes(to)) return false;
  if (!transitions[from]?.includes(to)) return false;

  // These gates prevent a transaction hash or a wallet balance alone from
  // being misrepresented as final chain proof or an exchange-account credit.
  if (to === 'verified-on-chain') {
    return evidence.finalized === true
      && evidence.receiptSuccess === true
      && evidence.networkMatches === true
      && evidence.contractMatches === true
      && evidence.senderMatches === true
      && evidence.receiverMatches === true
      && evidence.amountMatches === true;
  }
  if (to === 'receiver-balance-observed') {
    return evidence.verifiedOnChain === true
      && evidence.networkMatches === true
      && evidence.contractMatches === true
      && typeof evidence.balanceBaseUnits === 'string'
      && /^[0-9]+$/.test(evidence.balanceBaseUnits);
  }
  if (to === 'exchange-credit-confirmed') {
    return evidence.receiverBalanceObserved === true
      && evidence.exchangeApiAuthorized === true
      && evidence.exchangeDepositStatus === 'credited'
      && typeof evidence.exchangeDepositId === 'string'
      && evidence.exchangeDepositId.trim().length > 0;
  }
  return true;
}

export function assertTransferStatusTransition(from, to, evidence = {}) {
  if (!canTransitionTransferStatus(from, to, evidence)) {
    throw new Error('transfer-status-transition-not-authorized');
  }
  return to;
}


function normalizeHexAddress(value) {
  if (typeof value !== 'string') return null;
  const hex = value.replace(/^0x/i, '');
  if (!/^(?:41)?[0-9a-f]{40}$/i.test(hex)) return null;
  return (hex.length === 42 && /^41/i.test(hex) ? hex.slice(2) : hex).toLowerCase();
}

/**
 * Derive lifecycle evidence from the solidified verifier result and the
 * request's expected values. Invalid inputs fail closed rather than throwing.
 */
export function buildSolidifiedTransferEvidence({ result, network, networkHosts, contract, from, to, amountSun }) {
  let amountMatches = false;
  try {
    amountMatches = typeof result?.amountSun === 'string'
      && /^[0-9]+$/.test(result.amountSun)
      && typeof amountSun === 'string'
      && /^[0-9]+$/.test(amountSun)
      && BigInt(result.amountSun) === BigInt(amountSun);
  } catch {
    amountMatches = false;
  }
  return {
    finalized: Number.isInteger(result?.blockNumber) && result.blockNumber > 0,
    receiptSuccess: result?.verified === true,
    networkMatches: typeof network === 'string'
      && !!networkHosts
      && Object.hasOwn(networkHosts, network),
    contractMatches: normalizeHexAddress(result?.tokenContractAddress) !== null
      && normalizeHexAddress(result?.tokenContractAddress) === normalizeHexAddress(contract),
    senderMatches: normalizeHexAddress(result?.fromAddress) !== null
      && normalizeHexAddress(result?.fromAddress) === normalizeHexAddress(from),
    receiverMatches: normalizeHexAddress(result?.toAddress) !== null
      && normalizeHexAddress(result?.toAddress) === normalizeHexAddress(to),
    amountMatches,
  };
}
