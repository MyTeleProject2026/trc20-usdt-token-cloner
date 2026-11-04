import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyFincraUsdtTrc20Evidence } from '../server/routes/fincra-payouts.mjs'

const TXID = 'a'.repeat(64)
const OWNER = 'T' + 'A'.repeat(33)
const RECIPIENT = 'T' + 'B'.repeat(33)
const WRONG_SENDER = 'T' + 'C'.repeat(33)
const CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const AMOUNT = '12500000'
const TRANSFER_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

const addressMap = new Map([
  [OWNER, '41' + '1'.repeat(40)],
  [RECIPIENT, '41' + '2'.repeat(40)],
  [WRONG_SENDER, '41' + '3'.repeat(40)],
  [CONTRACT, '41' + '4'.repeat(40)],
])
const tronWeb = {
  address: { toHex: address => addressMap.get(address) || '' },
}
function eventAddress(address) {
  return addressMap.get(address).slice(2).padStart(64, '0')
}
function makeFixture({ sender=OWNER, logSender=sender, receiver=RECIPIENT, contract=CONTRACT, amount=AMOUNT, receiptResult='SUCCESS', blockNumber=123 }={}) {
  const recipientBytes = addressMap.get(receiver).slice(2)
  const contractHex = addressMap.get(contract)
  const amountHex = BigInt(amount).toString(16).padStart(64,'0')
  const data = 'a9059cbb' + recipientBytes.padStart(64,'0') + amountHex
  const tx = {
    txID: TXID,
    raw_data: {
      contract: [{
        type: 'TriggerSmartContract',
        parameter: { value: {
          owner_address: addressMap.get(sender),
          contract_address: contractHex,
          data,
        }},
      }],
    },
  }
  const info = {
    id: TXID,
    blockNumber,
    receipt: { result: receiptResult },
    log: [{
      address: contractHex,
      topics: [
        TRANSFER_TOPIC,
        eventAddress(logSender),
        eventAddress(receiver),
      ],
      data: amountHex,
    }],
  }
  return { transaction: tx, transactionInfo: info }
}
function verify(fixture=makeFixture(), overrides={}) {
  return verifyFincraUsdtTrc20Evidence(tronWeb,{
    transaction: fixture.transaction,
    transactionInfo: fixture.transactionInfo,
    transactionHash: TXID,
    recipientAddress: RECIPIENT,
    amountBaseUnits: AMOUNT,
    ...overrides,
  })
}

test('Tatum evidence confirms the exact official USDT transfer after a solidified successful receipt',()=>{
  const result=verify()
  assert.equal(result.status,'confirmed')
  assert.equal(result.verified,true)
  assert.equal(result.blockNumber,123)
})

test('provider success without a solidified receipt remains pending',()=>{
  const fixture=makeFixture({blockNumber:0})
  assert.equal(verify(fixture).status,'awaiting-solidified-receipt')
})

test('solidified failed receipt is distinguished from successful token transfer',()=>{
  const fixture=makeFixture({receiptResult:'REVERT'})
  const result=verify(fixture)
  assert.equal(result.status,'failed')
  assert.equal(result.verified,true)
})

test('rejects a Transfer event whose sender does not match the transaction owner',()=>{
  const result=verify(makeFixture({logSender:WRONG_SENDER}))
  assert.equal(result.status,'verification-mismatch')
  assert.equal(result.reason,'official-usdt-transfer-event-missing-or-mismatched')
})

test('rejects wrong recipient, amount, or token contract',()=>{
  assert.equal(verify(makeFixture({receiver:WRONG_SENDER})).status,'verification-mismatch')
  assert.equal(verify(makeFixture({amount:'12500001'})).status,'verification-mismatch')
  assert.equal(verify(makeFixture({contract:OWNER})).reason,'non-official-token-contract')
})

test('rejects unrelated tx IDs and multi-operation transactions',()=>{
  const wrongId=makeFixture()
  wrongId.transactionInfo.id='b'.repeat(64)
  assert.equal(verify(wrongId).status,'awaiting-solidified-receipt')
  const multi=makeFixture()
  multi.transaction.raw_data.contract.push({...multi.transaction.raw_data.contract[0]})
  assert.equal(verify(multi).reason,'unexpected-transaction-operation')
})
