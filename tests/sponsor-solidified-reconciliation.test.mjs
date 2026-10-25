import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import {
  createSponsorSolidifiedReconciliationRouter,
  readSolidifiedSponsorTransferEvidence,
} from '../server/routes/sponsor-solidified-reconciliation.mjs'

const adminToken = 'solidified-reconcile-test-admin-token-012345'
const sponsor = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
const receiver = 'TTGhREx2pDSxFX555NWz1YwGpiBVPvQA7e'
const token = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH'
const key = 'sponsor-solidified-reconciliation-test-0001'
const txid = 'a'.repeat(64)
const env = { SPONSOR_ADMIN_API_TOKEN: adminToken }

function transfer(overrides = {}) {
  return {
    idempotencyKey: key, sponsorReference: 'pilot-principal',
    sponsorAddress: sponsor, network: 'nile', purpose: 'asset-grant',
    asset: 'TRX', tokenContract: null, receiverAddress: receiver,
    amountBaseUnits: '2500000', status: 'submitted', transactionHash: txid,
    ...overrides,
  }
}
function baseEvidence(item, blockNumber = 100) {
  return {
    success: true, status: 'solidified-transfer-verified', network: item.network,
    transactionHash: item.transactionHash, blockNumber, executionResult: 'SUCCESS',
    asset: item.asset, tokenContract: item.tokenContract,
    fromAddress: item.sponsorAddress, toAddress: item.receiverAddress,
    amountBaseUnits: item.amountBaseUnits, logIndex: item.asset === 'TRX' ? undefined : 2,
    evidenceSource: 'test-solidified-proof',
  }
}
async function testServer(t, opts = {}) {
  const app = express()
  app.use(express.json())
  app.use('/api/tron', createSponsorSolidifiedReconciliationRouter({
    env,
    lookupTransfer: async () => ({ success: true, transfer: transfer() }),
    readEvidence: async (item) => baseEvidence(item),
    persistNative: async () => ({ persisted: true }),
    persistToken: async () => ({ persisted: true }),
    confirmTransfer: async () => ({ updated: true, duplicate: false, status: 'confirmed' }),
    finalizeBroadcast: async () => ({ updated: true, status: 'submitted' }),
    readCosts: async () => ({ success: false, reason: 'test-cost-observation-omitted' }),
    ...opts,
  }))
  const server = createServer(app)
  t.after(() => new Promise((resolve) => server.close(resolve)))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return 'http://127.0.0.1:' + server.address().port + '/api/tron'
}
const headers = () => ({ Authorization: 'Bearer ' + adminToken, 'Content-Type': 'application/json' })
const reconcile = (base, extra = {}) => fetch(base + '/sponsorship/transfers/' + key + '/reconcile-solidified', {
  method: 'POST', headers: headers(), body: '{}', ...extra,
})

test('reconciliation requires server admin auth before looking up a transfer', async (t) => {
  let lookedUp = false
  const base = await testServer(t, { lookupTransfer: async () => { lookedUp = true; return { success: true, transfer: transfer() } } })
  const response = await fetch(base + '/sponsorship/transfers/' + key + '/reconcile-solidified', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  const payload = await response.json()
  assert.equal(response.status, 401)
  assert.equal(payload.error, 'unauthorized')
  assert.equal(payload.canSubmitSponsoredTransfer, false)
  assert.equal(payload.feeSponsorBudgetSettled, false)
  assert.equal(lookedUp, false)
})

test('reconciliation accepts no caller-selected hash, cost, status, contract, or recipient', async (t) => {
  let read = false
  const base = await testServer(t, { readEvidence: async () => { read = true; return { success: true } } })
  const response = await reconcile(base, { body: JSON.stringify({ transactionHash: 'b'.repeat(64), status: 'confirmed' }) })
  const payload = await response.json()
  assert.equal(response.status, 400)
  assert.equal(payload.error, 'unexpected-fields')
  assert.equal(read, false)
})

test('reconciliation persists exact solidified native evidence before confirming principal budget', async (t) => {
  const order = []
  const base = await testServer(t, {
    readEvidence: async (item) => { order.push('chain'); return baseEvidence(item, 100) },
    persistNative: async (item) => { order.push('persist'); assert.equal(item.amountSun, '2500000'); return { persisted: true } },
    confirmTransfer: async (item) => { order.push('confirm'); assert.equal(item.nextStatus, 'confirmed'); assert.equal(item.transactionHash, txid); return { updated: true, duplicate: false } },
  })
  const response = await reconcile(base)
  const payload = await response.json()
  assert.equal(response.status, 200)
  assert.equal(payload.status, 'solidified-transfer-ledger-confirmed')
  assert.deepEqual(order, ['chain', 'persist', 'confirm'])
  assert.equal(payload.principalLedger.principalSpendRecorded, true)
  assert.equal(payload.feeSponsorBudgetSettled, false)
  assert.equal(payload.userFundedFallbackAllowed, false)
})

test('reconciliation resolves an ambiguous broadcasting row only after a matching solidified receipt', async (t) => {
  const order = []
  const base = await testServer(t, {
    lookupTransfer: async () => ({ success: true, transfer: transfer({ status: 'broadcasting' }) }),
    readEvidence: async (item) => { order.push('chain'); return baseEvidence(item, 101) },
    persistNative: async () => { order.push('persist'); return { persisted: true } },
    finalizeBroadcast: async (item) => { order.push('finalize'); assert.equal(item.transactionHash, txid); return { updated: true } },
    confirmTransfer: async () => { order.push('confirm'); return { updated: true, duplicate: false } },
  })
  const response = await reconcile(base)
  assert.equal(response.status, 200)
  assert.deepEqual(order, ['chain', 'persist', 'finalize', 'confirm'])
})

test('reconciliation rejects mainnet, pending-review, failed, and mismatched transfer identities', async (t) => {
  for (const override of [
    { network: 'mainnet' }, { status: 'pending-review' }, { status: 'failed' }, { receiverAddress: sponsor },
  ]) {
    let read = false
    const base = await testServer(t, {
      lookupTransfer: async () => ({ success: true, transfer: transfer(override) }),
      readEvidence: async () => { read = true; return { success: true } },
    })
    const response = await reconcile(base)
    const payload = await response.json()
    assert.equal(response.status, 409)
    assert.equal(payload.canSubmitSponsoredTransfer, false)
    assert.equal(read, false)
  }
})

test('reconciliation stores token log index and does not confirm when evidence persistence fails', async (t) => {
  const order = []
  const base = await testServer(t, {
    lookupTransfer: async () => ({ success: true, transfer: transfer({ asset: 'USDT', tokenContract: token }) }),
    readEvidence: async (item) => ({ ...baseEvidence(item, 102), logIndex: 2 }),
    persistToken: async (item) => { order.push('persist'); assert.equal(item.logIndex, 2); assert.equal(item.status, 'verified-on-chain'); return { persisted: false, reason: 'database-not-configured' } },
    confirmTransfer: async () => { order.push('confirm'); return { updated: true } },
  })
  const response = await reconcile(base)
  const payload = await response.json()
  assert.equal(response.status, 503)
  assert.equal(payload.error, 'database-not-configured')
  assert.deepEqual(order, ['persist'])
})

test('reconciliation observes exact receipt costs but never marks separate fee sponsor budget settled', async (t) => {
  const feeSponsor = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH'
  const base = await testServer(t, {
    env: { ...env, SPONSOR_FEE_NILE_ADDRESS: feeSponsor },
    readCosts: async () => ({
      success: true, network: 'nile', transactionHash: txid, blockNumber: 100, executionResult: 'SUCCESS',
      reportedFeeSun: '15', energyFeeSun: '10', netFeeSun: '5', energyUsageTotal: '100',
      energyUsage: '90', netUsage: '4', energyPenaltyTotal: '10',
    }),
    persistCosts: async (item) => { assert.equal(item.feeSponsorAddress, feeSponsor); return { success: true, duplicate: false } },
  })
  const response = await reconcile(base)
  const payload = await response.json()
  assert.equal(response.status, 200)
  assert.equal(payload.chainCostObservation.status, 'solidified-costs-observed-not-settled')
  assert.equal(payload.feeSponsorBudgetSettled, false)
  assert.equal(payload.chainCostObservation.sponsorFeeBudgetSettled, false)
})

test('solidified transfer reader is restricted to fixed Nile host and verifies exact native transfer', async () => {
  const secret = 'provider-secret-must-not-leak-from-reconciliation'
  const fakeTronWeb = {
    isAddress: (value) => [sponsor, receiver].includes(value),
    address: { toHex: (value) => value === sponsor ? '41' + '11'.repeat(20) : '41' + '22'.repeat(20) },
  }
  const transaction = {
    txID: txid, ret: [{ contractRet: 'SUCCESS' }],
    raw_data: { contract: [{ type: 'TransferContract', parameter: { value: {
      owner_address: '41' + '11'.repeat(20), to_address: '41' + '22'.repeat(20), amount: 2500000,
    } } }] },
  }
  const receipt = { id: txid, blockNumber: 103, receipt: { result: 'SUCCESS' } }
  const calls = []
  const result = await readSolidifiedSponsorTransferEvidence({
    transfer: transfer(), env: { TATUM_API_KEY: secret }, tronWebFactory: () => fakeTronWeb,
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return { ok: true, json: async () => url.endsWith('gettransactionbyid') ? transaction : receipt }
    },
  })
  assert.equal(result.success, true)
  assert.equal(result.blockNumber, 103)
  assert.equal(calls.length, 2)
  assert.ok(calls.every((call) => call.url.startsWith('https://tron-nile.gateway.tatum.io/')))
  assert.ok(calls.every((call) => call.options.headers['x-api-key'] === secret))
  assert.equal(JSON.stringify(result).includes(secret), false)
})

test('solidified reader rejects failed execution, wrong sender, wrong amount, and missing receipt', async () => {
  const fakeTronWeb = {
    isAddress: (value) => [sponsor, receiver].includes(value),
    address: { toHex: (value) => value === sponsor ? '41' + '11'.repeat(20) : '41' + '22'.repeat(20) },
  }
  const transaction = { txID: txid, ret: [{ contractRet: 'SUCCESS' }], raw_data: { contract: [{
    type: 'TransferContract', parameter: { value: { owner_address: '41' + '11'.repeat(20), to_address: '41' + '22'.repeat(20), amount: 2500000 } },
  }] } }
  const cases = [
    { tx: { ...transaction, ret: [{ contractRet: 'FAILED' }] }, info: { id: txid, blockNumber: 1 } },
    { tx: { ...transaction, raw_data: { contract: [{ type: 'TransferContract', parameter: { value: { owner_address: '41' + '33'.repeat(20), to_address: '41' + '22'.repeat(20), amount: 2500000 } } }] } }, info: { id: txid, blockNumber: 1 } },
    { tx: { ...transaction, raw_data: { contract: [{ type: 'TransferContract', parameter: { value: { owner_address: '41' + '11'.repeat(20), to_address: '41' + '22'.repeat(20), amount: 7 } } }] } }, info: { id: txid, blockNumber: 1 } },
    { tx: transaction, info: { id: txid } },
  ]
  for (const item of cases) {
    const result = await readSolidifiedSponsorTransferEvidence({
      transfer: transfer(), env: { TATUM_API_KEY: 'x' }, tronWebFactory: () => fakeTronWeb,
      fetchImpl: async (url) => ({ ok: true, json: async () => url.endsWith('gettransactionbyid') ? item.tx : item.info }),
    })
    assert.equal(result.success, false)
  }
})
