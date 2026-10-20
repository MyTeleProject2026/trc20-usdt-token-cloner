import test from 'node:test';
import assert from 'node:assert/strict';
import { TRANSFER_STATUSES, canTransitionTransferStatus, assertTransferStatusTransition } from '../server/transfer-lifecycle.mjs';

const completeChainEvidence = {
  finalized: true,
  receiptSuccess: true,
  networkMatches: true,
  contractMatches: true,
  senderMatches: true,
  receiverMatches: true,
  amountMatches: true,
};

test('declares distinct submission, chain, receiver, and exchange-credit statuses', () => {
  assert.deepEqual(TRANSFER_STATUSES, [
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
});

test('does not treat a transaction hash as finalized on-chain proof', () => {
  assert.equal(canTransitionTransferStatus('awaiting-finality', 'verified-on-chain', { txHash: 'abc' }), false);
  assert.equal(canTransitionTransferStatus('awaiting-finality', 'verified-on-chain', completeChainEvidence), true);
});

test('requires exact network, contract, sender, receiver, amount and successful finalized receipt', () => {
  for (const field of Object.keys(completeChainEvidence)) {
    assert.equal(
      canTransitionTransferStatus('awaiting-finality', 'verified-on-chain', { ...completeChainEvidence, [field]: false }),
      false,
      field,
    );
  }
});

test('receiver balance observation requires prior chain verification and integer base units', () => {
  assert.equal(canTransitionTransferStatus('verified-on-chain', 'receiver-balance-observed', {
    verifiedOnChain: true, networkMatches: true, contractMatches: true, balanceBaseUnits: '1000',
  }), true);
  assert.equal(canTransitionTransferStatus('verified-on-chain', 'receiver-balance-observed', {
    verifiedOnChain: false, networkMatches: true, contractMatches: true, balanceBaseUnits: '1000',
  }), false);
  assert.equal(canTransitionTransferStatus('verified-on-chain', 'receiver-balance-observed', {
    verifiedOnChain: true, networkMatches: true, contractMatches: true, balanceBaseUnits: '1.2',
  }), false);
});

test('exchange credit requires authorized exchange evidence and a credited deposit ID', () => {
  const evidence = {
    receiverBalanceObserved: true,
    exchangeApiAuthorized: true,
    exchangeDepositStatus: 'credited',
    exchangeDepositId: 'deposit-123',
  };
  assert.equal(canTransitionTransferStatus('receiver-balance-observed', 'exchange-credit-confirmed', evidence), true);
  assert.equal(canTransitionTransferStatus('receiver-balance-observed', 'exchange-credit-confirmed', {
    ...evidence, exchangeApiAuthorized: false,
  }), false);
  assert.equal(canTransitionTransferStatus('receiver-balance-observed', 'exchange-credit-confirmed', {
    ...evidence, exchangeDepositStatus: 'pending',
  }), false);
  assert.equal(canTransitionTransferStatus('receiver-balance-observed', 'exchange-credit-confirmed', {
    ...evidence, exchangeDepositId: '',
  }), false);
});

test('terminal statuses cannot be advanced and invalid transitions throw', () => {
  assert.equal(canTransitionTransferStatus('failed', 'verified-on-chain', completeChainEvidence), false);
  assert.equal(canTransitionTransferStatus('exchange-credit-confirmed', 'failed'), false);
  assert.throws(() => assertTransferStatusTransition('submitted', 'exchange-credit-confirmed', {}), /transfer-status-transition-not-authorized/);
  assert.equal(assertTransferStatusTransition('draft', 'awaiting-wallet-signature'), 'awaiting-wallet-signature');
});
