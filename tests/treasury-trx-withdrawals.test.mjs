import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTreasuryTrxWithdrawalAuthorizationMessage,
} from '../src/treasury-withdrawal-auth.mjs'
import {
  matchesTreasuryTrxWithdrawalRequest,
  verifyTreasuryTrxTransferEvidence,
} from '../server/routes/treasury-withdrawals.mjs'

const ownerAddress = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
const treasuryAddress = 'TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax'
const recipientAddress = 'TLPsmx7qvAq5QGJSYxCBkXb6j9bQvVQ3yP'
const idempotencyKey = 'trx-withdrawal-12345678-1234-4123-8123-123456789abc'

test('TRX withdrawal request matching binds owner, treasury, recipient and amount', () => {
  const row = {
    owner_address: ownerAddress,
    treasury_address: treasuryAddress,
    recipient_address: recipientAddress,
    amount_base_units: '1234567',
  }
  const request = { ownerAddress, treasuryAddress, recipientAddress, amountBaseUnits: '1234567' }
  assert.equal(matchesTreasuryTrxWithdrawalRequest(row, request), true)
  assert.equal(matchesTreasuryTrxWithdrawalRequest(row, { ...request, amountBaseUnits: '1234568' }), false)
  assert.equal(matchesTreasuryTrxWithdrawalRequest(row, { ...request, recipientAddress: treasuryAddress }), false)
})

test('TRX native transfer verifier confirms only exact sender, recipient, amount, and confirmed block', () => {
  const hex = {
    [ownerAddress]: '41' + '11'.repeat(20),
    [treasuryAddress]: '41' + '22'.repeat(20),
    [recipientAddress]: '41' + '33'.repeat(20),
  }
  const txid = 'a'.repeat(64)
  const tronWeb = { address: { toHex: (address) => hex[address] || '' } }
  const transaction = {
    txID: txid,
    ret: [{ contractRet: 'SUCCESS' }],
    raw_data: { contract: [{
      type: 'TransferContract',
      parameter: { value: {
        owner_address: hex[treasuryAddress],
        to_address: hex[recipientAddress],
        amount: 1234567,
      } },
    }] },
  }
  const transactionInfo = { id: txid, blockNumber: 123, receipt: { result: 'SUCCESS' } }
  const options = { transaction, transactionInfo, transactionHash: txid, treasuryAddress, recipientAddress, amountBaseUnits: '1234567' }
  assert.deepEqual(verifyTreasuryTrxTransferEvidence(tronWeb, options), {
    verified: true, status: 'confirmed', reason: 'confirmed-solidified-successful-native-transfer', blockNumber: 123,
  })
  assert.equal(verifyTreasuryTrxTransferEvidence(tronWeb, {
    ...options, transactionInfo: { id: txid, blockNumber: 123 },
  }).status, 'awaiting-confirmed-receipt', 'a block number without an execution receipt is inconclusive')
  assert.equal(verifyTreasuryTrxTransferEvidence(tronWeb, {
    ...options, transaction: { ...transaction, ret: [{ contractRet: 'REVERT' }] },
  }).status, 'verification-mismatch', 'conflicting transaction and receipt results must not be called successful')
  assert.equal(verifyTreasuryTrxTransferEvidence(tronWeb, { ...options, amountBaseUnits: '7654321' }).status, 'verification-mismatch')
  assert.equal(verifyTreasuryTrxTransferEvidence(tronWeb, { ...options, recipientAddress: ownerAddress }).status, 'verification-mismatch')
  assert.equal(verifyTreasuryTrxTransferEvidence(tronWeb, {
    ...options, transactionInfo: { id: txid, blockNumber: 0, receipt: { result: 'SUCCESS' } },
  }).status, 'awaiting-confirmed-receipt')
})

test('TRX native transfer verifier treats an explicit failed result as failed after confirming request intent', () => {
  const hex = {
    [treasuryAddress]: '41' + '22'.repeat(20),
    [recipientAddress]: '41' + '33'.repeat(20),
  }
  const txid = 'b'.repeat(64)
  const tronWeb = { address: { toHex: (address) => hex[address] || '' } }
  const transaction = {
    txID: txid,
    ret: [{ contractRet: 'REVERT' }],
    raw_data: { contract: [{
      type: 'TransferContract',
      parameter: { value: { owner_address: hex[treasuryAddress], to_address: hex[recipientAddress], amount: 5000000 } },
    }] },
  }
  const result = verifyTreasuryTrxTransferEvidence(tronWeb, {
    transaction, transactionInfo: { id: txid, blockNumber: 456, receipt: { result: 'REVERT' } }, transactionHash: txid,
    treasuryAddress, recipientAddress, amountBaseUnits: '5000000',
  })
  assert.equal(result.verified, true)
  assert.equal(result.status, 'failed')
})

test('TRX withdrawal authorization rejects a non TRX amount, an invalid recipient and a malformed request key', () => {
  const base = { origin:'https://owner.example', ownerAddress, treasuryAddress, recipientAddress,
    amountBaseUnits:'1230000', idempotencyKey, authorizationExpiresAt:1_800_000_000_000 }
  const message = buildTreasuryTrxWithdrawalAuthorizationMessage(base)
  assert.match(message, /Asset: TRX/)
  assert.match(message, /Amount base units \(sun\): 1230000/)
  assert.throws(() => buildTreasuryTrxWithdrawalAuthorizationMessage({ ...base, recipientAddress:'T' }))
  assert.throws(() => buildTreasuryTrxWithdrawalAuthorizationMessage({ ...base, amountBaseUnits:'0' }))
  assert.throws(() => buildTreasuryTrxWithdrawalAuthorizationMessage({ ...base, idempotencyKey:'short' }))
})
