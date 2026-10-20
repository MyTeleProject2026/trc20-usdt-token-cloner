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
