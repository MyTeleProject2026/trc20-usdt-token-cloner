import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyIncomingUsdtDepositEvidence } from '../server/incoming-usdt-deposit-evidence.mjs'

const treasury = 'TU3kjFuhtEo42tsCBtfYUAZxoqQ4yuSLQ5'
const sender = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const tx = 'a'.repeat(64)
const event = {
  network: 'TRON_MAINNET',
  transactionHash: tx,
  fromAddress: sender,
  toAddress: treasury,
  tokenContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  decimals: 6,
  amountBaseUnits: '1000000000',
  blockNumber: 12345,
  logIndex: 0,
  finality: 'solidified',
}
const proof = {
  verified: true,
  transactionHash: tx,
  contract: event.tokenContract,
  from: sender,
  to: treasury,
  amountBaseUnits: event.amountBaseUnits,
  blockNumber: event.blockNumber,
  logIndex: event.logIndex,
}

test('exact solidified official USDT evidence to designated treasury matches but cannot credit or sweep', () => {
  const result = classifyIncomingUsdtDepositEvidence({ expectedTreasuryAddress: treasury, event, proof })
  assert.equal(result.evidenceMatches, true)
  assert.equal(result.status, 'evidence-matches-designated-treasury')
  assert.equal(result.ledgerCreditAuthorized, false)
  assert.equal(result.automaticSweepAuthorized, false)
  assert.equal(result.spendableBalanceImpact, 'none')
  assert.equal(result.payoutAuthorizationGranted, false)
  assert.equal(result.executionEnabled, false)
})

test('watch-address deposit is blocked when it is not the designated treasury', () => {
  const result = classifyIncomingUsdtDepositEvidence({
    expectedTreasuryAddress: 'THPvaUhoh2Qn2y9THCZML3H815hhFhn5YC',
    event,
    proof,
  })
  assert.equal(result.evidenceMatches, false)
  assert.ok(result.reasons.includes('deposit-destination-not-designated-treasury'))
  assert.equal(result.spendableBalanceImpact, 'none')
})

test('testnet, non-USDT, non-solidified and mismatched proof are blocked', () => {
  const variants = [
    { event: { ...event, network: 'NILE_TESTNET' }, proof },
    { event: { ...event, tokenContract: sender }, proof },
    { event: { ...event, finality: 'pending' }, proof },
    { event, proof: { ...proof, amountBaseUnits: '1000000001' } },
  ]
  for (const item of variants) {
    const result = classifyIncomingUsdtDepositEvidence({
      expectedTreasuryAddress: treasury,
      event: item.event,
      proof: item.proof,
    })
    assert.equal(result.evidenceMatches, false)
    assert.equal(result.ledgerCreditAuthorized, false)
    assert.equal(result.executionEnabled, false)
  }
})

test('missing evidence and malformed values fail closed', () => {
  const result = classifyIncomingUsdtDepositEvidence({
    expectedTreasuryAddress: treasury,
    event: { ...event, amountBaseUnits: '01' },
    proof: {},
  })
  assert.equal(result.evidenceMatches, false)
  assert.ok(result.reasons.includes('deposit-amount-invalid'))
  assert.ok(result.reasons.includes('independent-transfer-proof-missing'))
  assert.equal(result.automaticSweepAuthorized, false)
  assert.equal(result.executionEnabled, false)
})
