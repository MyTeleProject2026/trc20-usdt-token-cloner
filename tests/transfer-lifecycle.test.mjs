import test from 'node:test';
import assert from 'node:assert/strict';
import { TRANSFER_STATUSES, canTransitionTransferStatus, assertTransferStatusTransition, buildSolidifiedTransferEvidence } from '../server/transfer-lifecycle.mjs';

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


test('derives positive solidified evidence only when every expected transfer field matches', () => {
  const networkHosts = { mainnet: 'https://api.trongrid.io', shasta: 'https://api.shasta.trongrid.io' };
  const result = {
    verified: true,
    blockNumber: 123,
    tokenContractAddress: '41' + '1'.repeat(40),
    fromAddress: '41' + '2'.repeat(40),
    toAddress: '41' + '3'.repeat(40),
    amountSun: '500000',
  };
  const expected = {
    result, network: 'mainnet', networkHosts,
    contract: result.tokenContractAddress,
    from: result.fromAddress, to: result.toAddress, amountSun: '500000',
  };
  const evidence = buildSolidifiedTransferEvidence(expected);
  assert.equal(canTransitionTransferStatus('awaiting-finality', 'verified-on-chain', evidence), true);
  assert.equal(buildSolidifiedTransferEvidence({ ...expected, amountSun: '500001' }).amountMatches, false);
  assert.equal(buildSolidifiedTransferEvidence({ ...expected, network: 'unknown' }).networkMatches, false);
  assert.equal(buildSolidifiedTransferEvidence({ ...expected, to: '41' + '4'.repeat(40) }).receiverMatches, false);
  assert.equal(buildSolidifiedTransferEvidence({ ...expected, result: { ...result, blockNumber: 0 } }).finalized, false);
  assert.equal(buildSolidifiedTransferEvidence({ ...expected, result: { ...result, verified: false } }).receiptSuccess, false);
  assert.equal(buildSolidifiedTransferEvidence({ ...expected, result: { ...result, tokenContractAddress: '41' + '4'.repeat(40) } }).contractMatches, false);
  assert.equal(buildSolidifiedTransferEvidence({ ...expected, result: { ...result, fromAddress: '41' + '4'.repeat(40) } }).senderMatches, false);
  assert.equal(buildSolidifiedTransferEvidence({ ...expected, result: { ...result, amountSun: '-1' } }).amountMatches, false);
  assert.equal(buildSolidifiedTransferEvidence({ ...expected, networkHosts: {} }).networkMatches, false);
});

test('malformed lifecycle evidence fails closed without throwing', () => {
  const evidence = buildSolidifiedTransferEvidence({
    result: { verified: true, amountSun: 'not-an-integer' },
    network: 'unknown', networkHosts: { mainnet: 'https://api.trongrid.io' },
    contract: 'invalid', from: 'invalid', to: 'invalid', amountSun: '1',
  });
  assert.equal(evidence.networkMatches, false);
  assert.equal(evidence.contractMatches, false);
  assert.equal(evidence.senderMatches, false);
  assert.equal(evidence.receiverMatches, false);
  assert.equal(evidence.amountMatches, false);
});
