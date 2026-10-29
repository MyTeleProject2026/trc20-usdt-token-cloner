import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { createTreasuryWithdrawalsRouter, isUnifiedTreasuryOwnerConfiguration, matchesTreasuryWithdrawalRequest, parsePositiveDecimal, requiredTreasuryFeeReserveSun, treasuryFeeCapCovered, treasuryFeeReserveCovered, trxConfiguration, unreservedTreasuryBalance, verifyTreasuryTransferEvidence } from '../server/routes/treasury-withdrawals.mjs'

test('treasury payouts require the owner-console and treasury owner address to match exactly', () => {
  const owner = 'T' + 'A'.repeat(33)
  assert.equal(isUnifiedTreasuryOwnerConfiguration({
    OWNER_WALLET_ADDRESS: owner,
    TREASURY_OWNER_ADDRESS: owner,
  }), true)
  assert.equal(isUnifiedTreasuryOwnerConfiguration({
    OWNER_WALLET_ADDRESS: owner,
    TREASURY_OWNER_ADDRESS: 'T' + 'B'.repeat(33),
  }), false)
  assert.equal(isUnifiedTreasuryOwnerConfiguration({
    TREASURY_OWNER_ADDRESS: owner,
  }), false)
  assert.equal(isUnifiedTreasuryOwnerConfiguration({
    OWNER_WALLET_ADDRESS: 'invalid',
    TREASURY_OWNER_ADDRESS: 'invalid',
  }), false)
})

test('native TRX payout never enables through a legacy application-held hot wallet', () => {
  const owner = 'T' + 'A'.repeat(33)
  const config = trxConfiguration({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://example.invalid/db',
    OWNER_WALLET_ADDRESS: owner,
    TREASURY_OWNER_ADDRESS: owner,
    TREASURY_ADDRESS: owner,
    TREASURY_PRIVATE_KEY: 'placeholder-not-a-real-key',
    TREASURY_MAX_PAYOUT_TRX: '10',
    TREASURY_DAILY_LIMIT_TRX: '100',
    TREASURY_FEE_LIMIT_SUN: '50000000',
    TREASURY_TRX_WITHDRAWALS_ENABLED: 'true',
    TREASURY_SIGNER_MODE: 'env-hot-wallet',
  })
  assert.equal(config.enabled, false)
  assert.ok(config.missing.includes('FIREBLOCKS_TRX_ASSET_ID'))
  assert.ok(config.missing.includes('TREASURY_SIGNER_MODE=fireblocks'))
})

test('native TRX payout does not fall back to the legacy key in Fireblocks signer mode', () => {
  const owner = 'T' + 'A'.repeat(33)
  const config = trxConfiguration({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://example.invalid/db',
    OWNER_WALLET_ADDRESS: owner,
    TREASURY_OWNER_ADDRESS: owner,
    TREASURY_ADDRESS: owner,
    TREASURY_MAX_PAYOUT_TRX: '10',
    TREASURY_DAILY_LIMIT_TRX: '100',
    TREASURY_FEE_LIMIT_SUN: '50000000',
    TREASURY_TRX_WITHDRAWALS_ENABLED: 'true',
    TREASURY_SIGNER_MODE: 'fireblocks',
  })
  assert.equal(config.enabled, false)
})

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

test('USDT parser rejects values above uint256 and accepts its exact six-decimal maximum', () => {
  const maxUint256 = (1n << 256n) - 1n
  assert.equal(
    parsePositiveDecimal('115792089237316195423570985008687907853269984665640564039457584007913129.639935'),
    maxUint256,
  )
  assert.equal(parsePositiveDecimal('1'.repeat(78)), null)
  assert.equal(parsePositiveDecimal('9'.repeat(5000)), null)
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
const transferEventTopic = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const usdtContract = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

function validEvidence({ receiptResult = 'SUCCESS', amount = amountBaseUnits, recipient = recipientAddress } = {}) {
  const recipientHex = addressHex.get(recipient).slice(2)
  const data = 'a9059cbb' + recipientHex.padStart(64, '0')
    + BigInt(amount).toString(16).padStart(64, '0')
  const senderTopic = '0x' + addressHex.get(treasuryAddress).slice(2).padStart(64, '0')
  const recipientTopic = '0x' + recipientHex.padStart(64, '0')
  return {
    transaction: {
      txID: txid,
      raw_data: { contract: [{
        type: 'TriggerSmartContract',
        parameter: { value: {
          owner_address: addressHex.get(treasuryAddress),
          contract_address: addressHex.get(usdtContract),
          data,
        } },
      }] },
    },
    transactionInfo: {
      id: txid,
      blockNumber: 12345,
      receipt: receiptResult ? { result: receiptResult } : {},
      log: [{
        address: addressHex.get(usdtContract).slice(2),
        topics: ['0x' + transferEventTopic, senderTopic, recipientTopic],
        data: '0x' + BigInt(amount).toString(16).padStart(64, '0'),
      }],
    },
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
    reason: 'confirmed-solidified-successful-receipt-and-transfer-event',
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

test('treasury receipt verifier refuses success when the official USDT Transfer event is missing or mismatched', () => {
  const missing = validEvidence()
  missing.transactionInfo.log = []
  assert.equal(verify(missing).status, 'verification-mismatch')
  assert.equal(verify(missing).reason, 'official-usdt-transfer-event-missing-or-mismatched')

  const wrongAmount = validEvidence()
  wrongAmount.transactionInfo.log[0].data = '0x' + BigInt(amountBaseUnits + '1').toString(16).padStart(64, '0')
  assert.equal(verify(wrongAmount).reason, 'official-usdt-transfer-event-missing-or-mismatched')

  const duplicate = validEvidence()
  duplicate.transactionInfo.log.push({ ...duplicate.transactionInfo.log[0], topics: [...duplicate.transactionInfo.log[0].topics] })
  assert.equal(verify(duplicate).reason, 'official-usdt-transfer-event-missing-or-mismatched')
})

test('treasury fee preflight requires real native TRX to cover the configured maximum fee cap', () => {
  assert.equal(treasuryFeeCapCovered('50000000', '50000000'), true)
  assert.equal(treasuryFeeCapCovered('50000001', '50000000'), true)
  assert.equal(treasuryFeeCapCovered('49999999', '50000000'), false)
  assert.equal(treasuryFeeCapCovered('0', '1'), false)
  assert.equal(treasuryFeeCapCovered('invalid', '50000000'), false)
  assert.equal(treasuryFeeCapCovered('50000000', '0'), false)
  assert.equal(treasuryFeeCapCovered('50000000', '1e6'), false)
})

test('cross-asset fee reserve budgets one fee cap per unresolved payout plus the new request', () => {
  const feeCap = '50000000'
  assert.equal(requiredTreasuryFeeReserveSun(feeCap, '0', '0'), '50000000')
  assert.equal(requiredTreasuryFeeReserveSun(feeCap, '1', '0'), '100000000')
  assert.equal(requiredTreasuryFeeReserveSun(feeCap, '0', '2'), '150000000')
  assert.equal(requiredTreasuryFeeReserveSun(feeCap, '2', '3'), '300000000')
  assert.equal(requiredTreasuryFeeReserveSun('0', '0', '0'), null)
  assert.equal(requiredTreasuryFeeReserveSun(feeCap, '-1', '0'), null)
  assert.equal(requiredTreasuryFeeReserveSun(feeCap, '01', '0'), null)
  assert.equal(requiredTreasuryFeeReserveSun('1000000000', '999999999999', '0'), null)
})

test('cross-asset fee reserve requires both on-chain and provider-available TRX to cover the full reserve', () => {
  assert.equal(treasuryFeeReserveCovered('100000000', '100000000', '100000000'), true)
  assert.equal(treasuryFeeReserveCovered('99999999', '100000000', '100000000'), false)
  assert.equal(treasuryFeeReserveCovered('100000000', '99999999', '100000000'), false)
  assert.equal(treasuryFeeReserveCovered('100000000', '100000000', '150000000'), false)
  assert.equal(treasuryFeeReserveCovered('invalid', '100000000', '100000000'), false)
  assert.equal(treasuryFeeReserveCovered('100000000', 'invalid', '100000000'), false)
})

test('treasury available-balance calculation reserves ambiguous or pending payouts conservatively', () => {
  assert.equal(unreservedTreasuryBalance('10000000', '2500000'), '7500000')
  assert.equal(unreservedTreasuryBalance('10000000', '10000000'), '0')
  assert.equal(unreservedTreasuryBalance('10000000', '12000000'), '0')
  assert.equal(unreservedTreasuryBalance('bad', '0'), null)
  assert.equal(unreservedTreasuryBalance('100', '1.5'), null)
})

test('withdrawal idempotency binds an existing key to the exact owner, treasury, recipient, token and amount', () => {
  const row = {
    owner_address: treasuryAddress,
    treasury_address: treasuryAddress,
    recipient_address: recipientAddress,
    token_contract: usdtContract,
    amount_base_units: amountBaseUnits,
  }
  const request = {
    ownerAddress: treasuryAddress,
    treasuryAddress,
    recipientAddress,
    amountBaseUnits,
  }
  assert.equal(matchesTreasuryWithdrawalRequest(row, request), true)
  assert.equal(matchesTreasuryWithdrawalRequest(row, { ...request, recipientAddress: treasuryAddress }), false)
  assert.equal(matchesTreasuryWithdrawalRequest(row, { ...request, amountBaseUnits: '1' }), false)
  assert.equal(matchesTreasuryWithdrawalRequest(row, { ...request, ownerAddress: recipientAddress }), false)
})
