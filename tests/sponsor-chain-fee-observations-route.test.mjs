import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import {
  createSponsorChainFeeObservationRouter,
  readSolidifiedSponsorChainFeeEvidence,
} from '../server/routes/sponsor-chain-fee-observations.mjs'

const token = 'sponsor-chain-fee-observation-tests-token-012345'
const principal = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
const receiver = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH'
const idempotencyKey = 'sponsor-chain-fee-observation-test-0001'
const txid = 'c'.repeat(64)
const ownerHex = '11'.repeat(20)
const receiverHex = '22'.repeat(20)

function transfer(overrides = {}) {
  return {
    success: true,
    transfer: {
      idempotencyKey, sponsorReference: 'sponsor-pilot',
      sponsorAddress: principal, network: 'nile', purpose: 'asset-grant',
      asset: 'TRX', tokenContract: null, receiverAddress: receiver,
      amountBaseUnits: '2500000', status: 'submitted', transactionHash: txid,
      ...overrides,
    },
  }
}

function createServerForTest(t, options = {}) {
  const app = express()
  app.use(express.json())
  app.use('/api/tron', createSponsorChainFeeObservationRouter({
    env: { SPONSOR_ADMIN_API_TOKEN: token },
    lookupTransfer: async () => transfer(),
    readEvidence: async (value) => ({
      success: true, network: value.network, transactionHash: value.transactionHash,
      blockNumber: 88, executionResult: 'FAILED',
      transactionOwnerAddressHex: ownerHex, trxFeePayerAddressHex: ownerHex,
      reportedFeeSun: '4200', energyFeeSun: '2000', netFeeSun: '2200',
      energyUsageTotal: '100', energyUsage: '100', originEnergyUsage: '0',
      netUsage: '220', energyPenaltyTotal: null,
    }),
    persistObservation: async () => ({ success: true, duplicate: false, settled: false }),
    listObservations: async ({ network, limit }) => ({ success: true, observations: [{ network, limit }] }),
    ...options,
  }))
  const server = createServer(app)
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve('http://127.0.0.1:' + server.address().port + '/api/tron')
  }))
}

const headers = () => ({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' })

test('failed solidified execution fee evidence is read without treating the asset transfer as successful', async () => {
  const calls = []
  const fakeTronWeb = {
    isAddress(value) { return [principal, receiver].includes(value) },
    address: { toHex(value) { return value === principal ? '41' + ownerHex : '41' + receiverHex } },
  }
  const transaction = {
    txID: txid,
    ret: [{ contractRet: 'REVERT' }],
    raw_data: { contract: [{ type: 'TransferContract', parameter: { value: {
      owner_address: '41' + ownerHex, to_address: '41' + receiverHex, amount: 2500000,
    } } }] },
  }
  const info = {
    id: txid, blockNumber: 89, result: 'FAILED',
    receipt: { result: 'REVERT', fee: 4200, energy_fee: 2000, net_fee: 2200, energy_usage_total: 100, energy_usage: 100, origin_energy_usage: 0, net_usage: 220 },
  }
  const result = await readSolidifiedSponsorChainFeeEvidence({
    transfer: transfer().transfer,
    env: { TATUM_API_KEY: 'test-provider-key' },
    tronWebFactory: () => fakeTronWeb,
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return { ok: true, json: async () => url.endsWith('gettransactionbyid') ? transaction : info }
    },
  })
  assert.equal(result.success, true)
  assert.equal(result.executionResult, 'FAILED')
  assert.equal(result.reportedFeeSun, '4200')
  assert.equal(result.transactionOwnerAddressHex, ownerHex)
  assert.equal(result.trxFeePayerAddressHex, ownerHex)
  assert.equal(result.blockNumber, 89)
  assert.equal(calls.length, 2)
  assert.ok(calls.every((call) => call.url.startsWith('https://tron-nile.gateway.tatum.io/')))
})


test('failed TRC20 fee evidence requires exact canonical transfer calldata', async () => {
  const tokenAddress = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
  const tokenHex = '33'.repeat(20)
  const fakeTronWeb = {
    isAddress(value) { return [principal, receiver, tokenAddress].includes(value) },
    address: { toHex(value) {
      if (value === principal) return '41' + ownerHex
      if (value === receiver) return '41' + receiverHex
      return '41' + tokenHex
    } },
  }
  const transferIntent = transfer({
    asset: 'USDT', tokenContract: tokenAddress,
    amountBaseUnits: '2500000',
  }).transfer
  const amountHex = BigInt(2500000).toString(16).padStart(64, '0')
  const calldata = 'a9059cbb' + '0'.repeat(24) + receiverHex + amountHex
  const transaction = {
    txID: txid,
    ret: [{ contractRet: 'REVERT' }],
    raw_data: { contract: [{ type: 'TriggerSmartContract', parameter: { value: {
      owner_address: '41' + ownerHex, contract_address: '41' + tokenHex, data: calldata,
    } } }] },
  }
  const info = {
    id: txid, blockNumber: 90, result: 'FAILED',
    receipt: { result: 'REVERT', fee: 5000, energy_fee: 5000, net_fee: 0 },
  }
  const read = (tx, receiptInfo = info) => readSolidifiedSponsorChainFeeEvidence({
    transfer: transferIntent,
    env: { TATUM_API_KEY: 'test-provider-key' },
    tronWebFactory: () => fakeTronWeb,
    fetchImpl: async (url) => ({ ok: true, json: async () => url.endsWith('gettransactionbyid') ? tx : receiptInfo }),
  })
  const valid = await read(transaction)
  assert.equal(valid.success, true)
  assert.equal(valid.executionResult, 'FAILED')
  assert.equal(valid.reportedFeeSun, '5000')

  const wrongRecipient = {
    ...transaction,
    raw_data: { contract: [{ type: 'TriggerSmartContract', parameter: { value: {
      owner_address: '41' + ownerHex, contract_address: '41' + tokenHex,
      data: 'a9059cbb' + '0'.repeat(24) + '44'.repeat(20) + amountHex,
    } } }] },
  }
  const invalid = await read(wrongRecipient)
  assert.deepEqual(invalid, { success: false, reason: 'solidified-transaction-intent-mismatch' })
  const contradictory = await read(transaction, {
    ...info, result: 'SUCCESS', receipt: { ...info.receipt, result: 'SUCCESS' },
  })
  assert.deepEqual(contradictory, { success: false, reason: 'solidified-execution-outcome-unknown' })
})

test('fee observation route requires admin authorization before lookup', async (t) => {
  let lookups = 0
  const base = await createServerForTest(t, { lookupTransfer: async () => { lookups += 1; return transfer() } })
  const response = await fetch(base + '/sponsorship/transfers/' + idempotencyKey + '/observe-chain-fees', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })
  assert.equal(response.status, 401)
  assert.equal((await response.json()).error, 'unauthorized')
  assert.equal(lookups, 0)
})

test('fee observation route stores finalized failed fees only and leaves principal transfer untouched', async (t) => {
  let stored
  let statusMutation = false
  const base = await createServerForTest(t, {
    persistObservation: async (value) => { stored = value; return { success: true, duplicate: false, settled: false } },
    confirmTransfer: async () => { statusMutation = true },
    failTransfer: async () => { statusMutation = true },
  })
  const response = await fetch(base + '/sponsorship/transfers/' + idempotencyKey + '/observe-chain-fees', {
    method: 'POST', headers: headers(), body: '{}',
  })
  const payload = await response.json()
  assert.equal(response.status, 200)
  assert.equal(payload.status, 'solidified-chain-fee-observed-not-settled')
  assert.equal(payload.executionResult, 'FAILED')
  assert.equal(payload.observedCosts.reportedFeeSun, '4200')
  assert.equal(payload.feeSponsorDebitVerified, false)
  assert.equal(payload.sponsorFeeBudgetSettled, false)
  assert.equal(payload.canSubmitSponsoredTransfer, false)
  assert.equal(stored.executionResult, 'FAILED')
  assert.equal(stored.idempotencyKey, idempotencyKey)
  assert.equal(stored.transactionHash, txid)
  assert.equal(statusMutation, false)
})

test('fee observation route rejects caller-supplied fee and transaction values', async (t) => {
  let read = false
  const base = await createServerForTest(t, { readEvidence: async () => { read = true; return { success: true } } })
  const response = await fetch(base + '/sponsorship/transfers/' + idempotencyKey + '/observe-chain-fees', {
    method: 'POST', headers: headers(), body: JSON.stringify({ transactionHash: 'd'.repeat(64), reportedFeeSun: '1' }),
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error, 'unexpected-fields')
  assert.equal(read, false)
})

test('fee observation route refuses Mainnet and non-submitted transfers', async (t) => {
  for (const overrides of [{ network: 'mainnet' }, { status: 'pending-review' }]) {
    const base = await createServerForTest(t, { lookupTransfer: async () => transfer(overrides) })
    const response = await fetch(base + '/sponsorship/transfers/' + idempotencyKey + '/observe-chain-fees', {
      method: 'POST', headers: headers(), body: '{}',
    })
    assert.equal(response.status, 409)
    assert.equal((await response.json()).canSubmitSponsoredTransfer, false)
  }
})

test('fee observation history is admin-gated and bounded', async (t) => {
  const base = await createServerForTest(t)
  const denied = await fetch(base + '/sponsorship/chain-fee-observations')
  assert.equal(denied.status, 401)
  const allowed = await fetch(base + '/sponsorship/chain-fee-observations?network=nile&limit=5', { headers: headers() })
  const payload = await allowed.json()
  assert.equal(allowed.status, 200)
  assert.equal(payload.status, 'sponsor-chain-fee-observations-read')
  assert.equal(payload.sponsorFeeBudgetSettled, false)
})

test('failed principal reconciliation uses only stored transaction identity and database evidence gate', async (t) => {
  let transitionInput
  const base = await createServerForTest(t, {
    transitionTransfer: async (value) => { transitionInput = value; return { updated: true, duplicate: false, status: 'failed' } },
  })
  const response = await fetch(base + '/sponsorship/transfers/' + idempotencyKey + '/reconcile-failed', {
    method: 'POST', headers: headers(), body: '{}',
  })
  const payload = await response.json()
  assert.equal(response.status, 200)
  assert.equal(payload.status, 'failed')
  assert.equal(payload.principalReservationReleased, true)
  assert.equal(payload.feeBudgetSettled, false)
  assert.equal(payload.canSubmitSponsoredTransfer, false)
  assert.deepEqual(transitionInput, {
    idempotencyKey, nextStatus: 'failed', transactionHash: txid,
  })
})

test('failed principal reconciliation rejects caller-supplied transaction identity', async (t) => {
  let called = false
  const base = await createServerForTest(t, {
    transitionTransfer: async () => { called = true; return { updated: true } },
  })
  const response = await fetch(base + '/sponsorship/transfers/' + idempotencyKey + '/reconcile-failed', {
    method: 'POST', headers: headers(), body: JSON.stringify({ transactionHash: 'e'.repeat(64) }),
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error, 'unexpected-fields')
  assert.equal(called, false)
})

test('failed principal reconciliation refuses absent persisted FAILED fee evidence', async (t) => {
  const base = await createServerForTest(t, {
    transitionTransfer: async () => ({ updated: false, reason: 'finalized-failure-fee-observation-required' }),
  })
  const response = await fetch(base + '/sponsorship/transfers/' + idempotencyKey + '/reconcile-failed', {
    method: 'POST', headers: headers(), body: '{}',
  })
  const payload = await response.json()
  assert.equal(response.status, 409)
  assert.equal(payload.principalReservationReleased, false)
  assert.equal(payload.canSubmitSponsoredTransfer, false)
})
