import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { createTreasuryWithdrawalsRouter, parsePositiveDecimal, verifyTreasuryTransferEvidence } from '../server/routes/treasury-withdrawals.mjs'

test('USDT decimal parser converts exact six-decimal amounts to base units', () => {
  assert.equal(parsePositiveDecimal('1'), 1_000_000n)
  assert.equal(parsePositiveDecimal('0.000001'), 1n)
  assert.equal(parsePositiveDecimal('12.340500'), 12_340_500n)
})

test('USDT decimal parser rejects zero, excess precision, exponent notation and malformed input', () => {
  for (const value of ['0', '0.0000001', '-1', '+1', '1e3', '01', '.5', '1.', '', ' 1']) {
    assert.equal(parsePositiveDecimal(value), null, value)
  }
})

test('treasury endpoint requires an authenticated owner session before touching treasury configuration', async (t) => {
  const app = express()
  app.use(express.json())
  app.use('/api/treasury', createTreasuryWithdrawalsRouter({
    env: {},
    sessionLookup: async () => ({ success: true, session: null }),
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const address = server.address()
  const response = await fetch(`http://127.0.0.1:${address.port}/api/treasury/withdrawals/readiness`, {
    headers: { origin: 'https://owner.example' },
  })
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { success: false, error: 'owner-auth-required' })
})


const treasuryAddress = 'T' + 'A'.repeat(33)
const recipientAddress = 'T' + 'B'.repeat(33)
const txid = 'a'.repeat(64)
const amountBaseUnits = '12345000'
const addressHex = new Map([
  [treasuryAddress, '41' + '11'.repeat(20)],
  [recipientAddress, '41' + '22'.repeat(20)],
  ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', '41' + '33'.repeat(20)],
])
const fakeTronWeb = { address: { toHex: (address) => addressHex.get(address) || '' } }

function validEvidence({ receiptResult = 'SUCCESS', amount = amountBaseUnits, recipient = recipientAddress } = {}) {
  const recipientHex = addressHex.get(recipient).slice(2)
  const data = 'a9059cbb' + recipientHex.padStart(64, '0')
    + BigInt(amount).toString(16).padStart(64, '0')
  return {
    transaction: {
      txID: txid,
      raw_data: { contract: [{
        type: 'TriggerSmartContract',
        parameter: { value: {
          owner_address: addressHex.get(treasuryAddress),
          contract_address: addressHex.get('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'),
          data,
        } },
      }] },
    },
    transactionInfo: { id: txid, blockNumber: 12345, receipt: receiptResult ? { result: receiptResult } : {} },
  }
}

function verify(input = validEvidence()) {
  return verifyTreasuryTransferEvidence(fakeTronWeb, {
    ...input,
    transactionHash: txid,
    treasuryAddress,
    recipientAddress,
    amountBaseUnits,
  })
}

test('treasury receipt verifier confirms only the exact official-USDT transfer and successful solidified receipt', () => {
  assert.deepEqual(verify(), {
    verified: true,
    status: 'confirmed',
    reason: 'confirmed-solidified-successful-receipt',
    blockNumber: 12345,
  })
})

test('treasury receipt verifier rejects a different recipient, amount, sender, or token contract', () => {
  assert.equal(verify(validEvidence({ recipient: treasuryAddress })).status, 'verification-mismatch')
  assert.equal(verify(validEvidence({ amount: '12345001' })).status, 'verification-mismatch')

  const wrongSender = validEvidence()
  wrongSender.transaction.raw_data.contract[0].parameter.value.owner_address = '41' + '44'.repeat(20)
  assert.equal(verify(wrongSender).reason, 'sender-or-token-contract-mismatch')

  const wrongContract = validEvidence()
  wrongContract.transaction.raw_data.contract[0].parameter.value.contract_address = '41' + '55'.repeat(20)
  assert.equal(verify(wrongContract).reason, 'sender-or-token-contract-mismatch')
})

test('treasury receipt verifier reports failed contract execution as failed, not received USDT', () => {
  assert.deepEqual(verify(validEvidence({ receiptResult: 'REVERT' })), {
    verified: true,
    status: 'failed',
    reason: 'confirmed-solidified-failed-receipt',
    blockNumber: 12345,
  })
})

test('treasury receipt verifier leaves missing receipt evidence pending', () => {
  const evidence = validEvidence({ receiptResult: null })
  assert.equal(verify(evidence).status, 'awaiting-confirmed-receipt')
  assert.equal(verify(evidence).verified, false)
})

test('treasury receipt verifier rejects a transaction hash that does not match the returned transaction', () => {
  const evidence = validEvidence()
  evidence.transaction.txID = 'b'.repeat(64)
  assert.equal(verify(evidence).verified, false)
})
