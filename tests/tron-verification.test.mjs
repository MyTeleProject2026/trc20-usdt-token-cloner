import test from 'node:test'
import assert from 'node:assert/strict'
import { verifySolidifiedTrc20Transfer } from '../server/tron-verification.mjs'

const txId = 'a'.repeat(64)
const contract = '41' + '1'.repeat(40)
const from = '41' + '2'.repeat(40)
const to = '41' + '3'.repeat(40)
const topicAddress = (address) => address.replace(/^41/, '').padStart(64, '0')
const amount = 65000000n
const transaction = { txID: txId }
const receipt = {
  id: txId,
  blockNumber: 12345,
  receipt: { result: 'SUCCESS' },
  log: [{
    address: contract,
    topics: [
      'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      topicAddress(from),
      topicAddress(to),
    ],
    data: amount.toString(16).padStart(64, '0'),
  }],
}
const input = () => ({ transaction, receipt, expectedTxId: txId, tokenContractAddress: contract, fromAddress: from, toAddress: to, amountSun: amount.toString() })

test('accepts only a matching successful solidified TRC-20 Transfer event', () => {
  const result = verifySolidifiedTrc20Transfer(input())
  assert.equal(result.verified, true)
  assert.equal(result.amountSun, amount.toString())
  assert.equal(result.blockNumber, 12345)
})

test('rejects a missing or mismatched transaction body', () => {
  assert.equal(verifySolidifiedTrc20Transfer({ ...input(), transaction: {} }).reason, 'solidified-transaction-not-found-or-id-mismatch')
})

test('rejects a failed receipt even if a Transfer-shaped log is present', () => {
  const data = input()
  data.receipt = { ...receipt, receipt: { result: 'FAILED' } }
  assert.equal(verifySolidifiedTrc20Transfer(data).reason, 'contract-execution-not-successful')
})

test('rejects a transfer event emitted by a different token contract', () => {
  const data = input()
  data.receipt = { ...receipt, log: [{ ...receipt.log[0], address: '41' + '4'.repeat(40) }] }
  assert.equal(verifySolidifiedTrc20Transfer(data).reason, 'matching-transfer-event-not-found')
})

test('rejects mismatched recipient or amount', () => {
  assert.equal(verifySolidifiedTrc20Transfer({ ...input(), toAddress: '41' + '4'.repeat(40) }).reason, 'matching-transfer-event-not-found')
  assert.equal(verifySolidifiedTrc20Transfer({ ...input(), amountSun: '1' }).reason, 'matching-transfer-event-not-found')
})

test('rejects missing solidified block metadata', () => {
  const data = input()
  data.receipt = { ...receipt, blockNumber: 0 }
  assert.equal(verifySolidifiedTrc20Transfer(data).reason, 'receipt-has-no-solidified-block')
})

test('rejects a top-level failed solidified execution result', () => {
  const data = input()
  data.receipt = { ...receipt, result: 'FAILED' }
  assert.equal(verifySolidifiedTrc20Transfer(data).reason, 'contract-execution-not-successful')
})

test('rejects a failed contract result in the solidified transaction body', () => {
  const data = input()
  data.transaction = { ...transaction, ret: [{ contractRet: 'REVERT' }] }
  assert.equal(verifySolidifiedTrc20Transfer(data).reason, 'transaction-contract-execution-not-successful')
})

test('preserves valid 20-byte addresses that begin with the hex digits 41', () => {
  const contract20 = '41' + '1'.repeat(38)
  const from20 = '41' + '2'.repeat(38)
  const to20 = '41' + '3'.repeat(38)
  const data = input()
  data.tokenContractAddress = contract20
  data.fromAddress = from20
  data.toAddress = to20
  data.receipt = {
    ...receipt,
    log: [{
      ...receipt.log[0],
      address: contract20,
      topics: [receipt.log[0].topics[0], from20.padStart(64, '0'), to20.padStart(64, '0')],
    }],
  }
  assert.equal(verifySolidifiedTrc20Transfer(data).verified, true)
})
