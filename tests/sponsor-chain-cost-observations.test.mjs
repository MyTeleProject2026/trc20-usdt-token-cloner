import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import {
  createSponsorChainCostObservationRouter,
  readSolidifiedSponsorChainCosts,
} from '../server/routes/sponsor-chain-cost-observations.mjs'

const adminToken = 'sponsor-chain-cost-observation-tests-token-012345'
const principal = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
const feeSponsor = 'TTGhREx2pDSxFX555NWz1YwGpiBVPvQA7e'
const receiver = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH'
const token = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const idempotencyKey = 'sponsor-chain-cost-observation-test-0001'
const txid = 'a'.repeat(64)

function transfer(overrides = {}) {
  return {
    success: true,
    transfer: {
      idempotencyKey,
      sponsorReference: 'sponsor-pilot',
      sponsorAddress: principal,
      network: 'nile',
      purpose: 'asset-grant',
      asset: 'TRX',
      tokenContract: null,
      receiverAddress: receiver,
      amountBaseUnits: '2500000',
      status: 'confirmed',
      transactionHash: txid,
      ...overrides,
    },
  }
}

function createServerForTest(t, options = {}) {
  const app = express()
  app.use(express.json())
  app.use('/api/tron', createSponsorChainCostObservationRouter({
    env: { SPONSOR_ADMIN_API_TOKEN: adminToken, SPONSOR_FEE_NILE_ADDRESS: feeSponsor },
    lookupTransfer: async () => transfer(),
    readChainCosts: async (value) => ({
      success: true, network: value.network, transactionHash: value.transactionHash,
      blockNumber: 12, blockTimestampMs: 1700000000000, executionResult: 'SUCCESS', reportedFeeSun: '4200',
      energyFeeSun: '2000', netFeeSun: '2200', energyUsageTotal: '0',
      energyUsage: null, netUsage: '220', energyPenaltyTotal: null,
    }),
    persistObservation: async (value) => ({ success: true, duplicate: false, observation: value }),
    listObservations: async ({ network, limit }) => ({ success: true, observations: [{ network, limit }] }),
    ...options,
  }))
  const server = createServer(app)
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve('http://127.0.0.1:' + server.address().port + '/api/tron')
  }))
}

const headers = () => ({ Authorization: 'Bearer ' + adminToken, 'Content-Type': 'application/json' })

test('cost observation requires admin authorization before database or chain access', async (t) => {
  let lookupCount = 0
  const base = await createServerForTest(t, { lookupTransfer: async () => { lookupCount += 1; return transfer() } })
  const response = await fetch(base + '/sponsorship/transfers/' + idempotencyKey + '/observe-chain-costs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })
  const payload = await response.json()
  assert.equal(response.status, 401)
  assert.equal(payload.error, 'unauthorized')
  assert.equal(payload.canSubmitSponsoredTransfer, false)
  assert.equal(lookupCount, 0)
})

test('cost observation uses stored confirmed transfer identity and persists only a chain observation', async (t) => {
  let persisted
  const base = await createServerForTest(t, {
    persistObservation: async (value) => { persisted = value; return { success: true, duplicate: false } },
  })
  const response = await fetch(base + '/sponsorship/transfers/' + idempotencyKey + '/observe-chain-costs', {
    method: 'POST', headers: headers(), body: '{}',
  })
  const payload = await response.json()
  assert.equal(response.status, 200)
  assert.equal(payload.status, 'solidified-chain-costs-observed-not-settled')
  assert.equal(payload.transactionHash, txid)
  assert.equal(payload.observedCosts.reportedFeeSun, '4200')
  assert.equal(payload.sponsorFeeBudgetSettled, false)
  assert.equal(payload.feeSponsorDebitVerified, false)
  assert.equal(payload.canSubmitSponsoredTransfer, false)
  assert.equal(persisted.feeSponsorAddress, feeSponsor)
  assert.equal(persisted.assetPrincipalAddress, principal)
  assert.equal(persisted.transactionHash, txid)
})

test('cost observation rejects a non-confirmed transfer without reading costs', async (t) => {
  let read = false
  const base = await createServerForTest(t, {
    lookupTransfer: async () => transfer({ status: 'submitted' }),
    readChainCosts: async () => { read = true; return { success: true } },
  })
  const response = await fetch(base + '/sponsorship/transfers/' + idempotencyKey + '/observe-chain-costs', {
    method: 'POST', headers: headers(), body: '{}',
  })
  const payload = await response.json()
  assert.equal(response.status, 409)
  assert.equal(payload.error, 'confirmed-transfer-required')
  assert.equal(read, false)
})

test('cost observation rejects arbitrary caller fields including a substitute transaction ID', async (t) => {
  let read = false
  const base = await createServerForTest(t, {
    readChainCosts: async () => { read = true; return { success: true } },
  })
  const response = await fetch(base + '/sponsorship/transfers/' + idempotencyKey + '/observe-chain-costs', {
    method: 'POST', headers: headers(), body: JSON.stringify({ transactionHash: 'b'.repeat(64), reportedFeeSun: '1' }),
  })
  const payload = await response.json()
  assert.equal(response.status, 400)
  assert.equal(payload.error, 'unexpected-fields')
  assert.equal(read, false)
})

test('cost observation is testnet-only and requires distinct role addresses', async (t) => {
  for (const overrides of [{ network: 'mainnet' }, { sponsorAddress: feeSponsor }]) {
    const base = await createServerForTest(t, { lookupTransfer: async () => transfer(overrides) })
    const response = await fetch(base + '/sponsorship/transfers/' + idempotencyKey + '/observe-chain-costs', {
      method: 'POST', headers: headers(), body: '{}',
    })
    const payload = await response.json()
    assert.equal(response.status, 409)
    assert.equal(payload.canSubmitSponsoredTransfer, false)
  }
})

test('solidified cost reader uses fixed Nile host and does not leak provider credentials', async () => {
  const secret = 'test-tatum-provider-secret-should-not-return'
  const calls = []
  const fakeTronWeb = {
    isAddress(value) { return [principal, receiver].includes(value) },
    address: { toHex(value) { return value === principal ? '41' + '11'.repeat(20) : '41' + '22'.repeat(20) } },
  }
  const transaction = {
    txID: txid,
    ret: [{ contractRet: 'SUCCESS' }],
    raw_data: { contract: [{
      type: 'TransferContract',
      parameter: { value: { owner_address: '41' + '11'.repeat(20), to_address: '41' + '22'.repeat(20), amount: 2500000 } },
    }] },
  }
  const info = {
    id: txid, blockNumber: 77, blockTimeStamp: 1700000000000, fee: 4200, result: 'SUCCESS',
    receipt: { net_fee: 2200, energy_fee: 2000, energy_usage_total: 0, net_usage: 220 },
  }
  const result = await readSolidifiedSponsorChainCosts({
    transfer: transfer().transfer,
    env: { TATUM_API_KEY: secret },
    tronWebFactory: () => fakeTronWeb,
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return { ok: true, json: async () => url.endsWith('gettransactionbyid') ? transaction : info }
    },
  })
  assert.equal(result.success, true)
  assert.equal(result.reportedFeeSun, '4200')
  assert.equal(result.blockNumber, 77)
  assert.equal(result.blockTimestampMs, 1700000000000)
  assert.equal(calls.length, 2)
  assert.ok(calls.every((call) => call.url.startsWith('https://tron-nile.gateway.tatum.io/')))
  assert.ok(calls.every((call) => call.options.headers['x-api-key'] === secret))
  assert.equal(JSON.stringify(result).includes(secret), false)
})

test('chain-cost observation history is admin-gated and bounded', async (t) => {
  const base = await createServerForTest(t)
  const denied = await fetch(base + '/sponsorship/chain-cost-observations')
  assert.equal(denied.status, 401)
  const allowed = await fetch(base + '/sponsorship/chain-cost-observations?network=nile&limit=5', { headers: headers() })
  const payload = await allowed.json()
  assert.equal(allowed.status, 200)
  assert.equal(payload.status, 'sponsor-chain-cost-observations-read')
  assert.equal(payload.sponsorFeeBudgetSettled, false)
})
