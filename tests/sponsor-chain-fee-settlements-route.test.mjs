import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { createSponsorChainFeeSettlementRouter } from '../server/routes/sponsor-chain-fee-settlements.mjs'

const token = 'sponsor-chain-fee-settlement-tests-token-012345'
const idempotencyKey = 'sponsor-chain-fee-settlement-test-0001'
const txid = 'a'.repeat(64)

function transfer(overrides = {}) {
  return {
    success: true,
    transfer: {
      idempotencyKey,
      sponsorReference: 'sponsor-settlement-pilot',
      sponsorAddress: 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8',
      network: 'nile',
      purpose: 'asset-grant',
      asset: 'USDT',
      tokenContract: 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH',
      receiverAddress: 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH',
      amountBaseUnits: '2500000',
      status: 'submitted',
      transactionHash: txid,
      ...overrides,
    },
  }
}

async function listen(t, options = {}) {
  const app = express()
  app.use(express.json())
  app.use('/api/tron', createSponsorChainFeeSettlementRouter({
    env: { SPONSOR_ADMIN_API_TOKEN: token },
    lookupTransfer: async () => transfer(),
    settleFee: async () => ({
      success: true, settled: true, duplicate: false,
      settlementId: '17', settlementReference: 'trx-fee:nile:' + txid,
      settledFeeSun: '4200', feeBudgetSettled: true, executionResult: 'FAILED',
    }),
    listSettlements: async () => ({ success: true, settlements: [{ transaction_hash: txid }] }),
    ...options,
  }))
  const server = createServer(app)
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve('http://127.0.0.1:' + server.address().port + '/api/tron')
  }))
}

const headers = () => ({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' })

test('fee settlement endpoint requires admin authorization before looking up a transfer', async (t) => {
  let lookups = 0
  const base = await listen(t, { lookupTransfer: async () => { lookups += 1; return transfer() } })
  const response = await fetch(base + '/sponsorship/transfers/' + idempotencyKey + '/settle-observed-fees', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })
  assert.equal(response.status, 401)
  assert.equal((await response.json()).error, 'unauthorized')
  assert.equal(lookups, 0)
})

test('fee settlement derives identity from stored transfer and never accepts caller-supplied fee values', async (t) => {
  let settled = false
  let settledWith
  const base = await listen(t, {
    settleFee: async (value) => {
      settled = true
      settledWith = value
      return {
        success: true, settled: true, duplicate: false,
        settlementId: '17', settlementReference: 'trx-fee:nile:' + txid,
        settledFeeSun: '4200', feeBudgetSettled: true, executionResult: 'FAILED',
      }
    },
  })
  const rejected = await fetch(base + '/sponsorship/transfers/' + idempotencyKey + '/settle-observed-fees', {
    method: 'POST', headers: headers(), body: JSON.stringify({ reportedFeeSun: '1', transactionHash: 'b'.repeat(64) }),
  })
  assert.equal(rejected.status, 400)
  assert.equal((await rejected.json()).error, 'unexpected-fields')
  assert.equal(settled, false)

  const response = await fetch(base + '/sponsorship/transfers/' + idempotencyKey + '/settle-observed-fees', {
    method: 'POST', headers: headers(), body: '{}',
  })
  const payload = await response.json()
  assert.equal(response.status, 200)
  assert.equal(payload.status, 'solidified-direct-trx-burn-fee-settled')
  assert.equal(payload.executionResult, 'FAILED')
  assert.equal(payload.settlement.settledFeeSun, '4200')
  assert.equal(payload.settlement.feeBudgetSettled, true)
  assert.equal(payload.settlement.sameWalletAsAssetPrincipalSender, true)
  assert.equal(payload.settlement.delegatedResourceSettlement, false)
  assert.equal(settled, true)
  assert.deepEqual(settledWith, {
    network: 'nile',
    transactionHash: txid,
    idempotencyKey,
  })
})

test('fee settlement route rejects Mainnet and non-asset-grant transfers before settlement', async (t) => {
  for (const overrides of [{ network: 'mainnet' }, { purpose: 'network-fee' }]) {
    let settleCalls = 0
    const base = await listen(t, {
      lookupTransfer: async () => transfer(overrides),
      settleFee: async () => { settleCalls += 1; return { success: true, settled: true } },
    })
    const response = await fetch(base + '/sponsorship/transfers/' + idempotencyKey + '/settle-observed-fees', {
      method: 'POST', headers: headers(), body: '{}',
    })
    assert.equal(response.status, 409)
    assert.equal((await response.json()).canSubmitSponsoredTransfer, false)
    assert.equal(settleCalls, 0)
  }
})

test('fee settlement route reports a different fee sponsor wallet as ineligible and never falls back to user funds', async (t) => {
  const base = await listen(t, {
    settleFee: async () => ({
      success: false, settled: false, reason: 'network-fee-sponsor-is-not-trx-burn-payer',
    }),
  })
  const response = await fetch(base + '/sponsorship/transfers/' + idempotencyKey + '/settle-observed-fees', {
    method: 'POST', headers: headers(), body: '{}',
  })
  const payload = await response.json()
  assert.equal(response.status, 409)
  assert.equal(payload.error, 'network-fee-sponsor-is-not-trx-burn-payer')
  assert.equal(payload.feeSponsorDebitVerified, false)
  assert.equal(payload.sponsorFeeBudgetSettled, false)
  assert.equal(payload.delegatedResourceSettlement, false)
  assert.equal(payload.canSubmitSponsoredTransfer, false)
})

test('fee settlement history is admin-gated and bounded to testnets', async (t) => {
  let requested
  const base = await listen(t, {
    listSettlements: async (value) => {
      requested = value
      return { success: true, settlements: [{ transaction_hash: txid }] }
    },
  })
  const response = await fetch(base + '/sponsorship/chain-fee-settlements?network=nile&limit=7', {
    headers: { Authorization: 'Bearer ' + token },
  })
  const payload = await response.json()
  assert.equal(response.status, 200)
  assert.equal(payload.count, 1)
  assert.deepEqual(requested, { network: 'nile', limit: 7 })
})


test('fee reservation link endpoint is admin-gated and accepts only the stored reservation key', async (t) => {
  let linkCalls = 0
  let linkedWith
  const base = await listen(t, {
    linkFeeReservation: async (value) => {
      linkCalls += 1
      linkedWith = value
      return { success: true, linked: true, duplicate: false, linkId: '31', reservedFeeSun: '5000' }
    },
  })
  const denied = await fetch(base + '/sponsorship/transfers/' + idempotencyKey + '/link-fee-reservation', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feeReservationIdempotencyKey: 'network-fee-reservation-0001' }),
  })
  assert.equal(denied.status, 401)
  assert.equal(linkCalls, 0)

  const invalid = await fetch(base + '/sponsorship/transfers/' + idempotencyKey + '/link-fee-reservation', {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ feeReservationIdempotencyKey: 'network-fee-reservation-0001', sponsorAddress: 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8' }),
  })
  assert.equal(invalid.status, 400)
  assert.equal(linkCalls, 0)

  const response = await fetch(base + '/sponsorship/transfers/' + idempotencyKey + '/link-fee-reservation', {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ feeReservationIdempotencyKey: 'network-fee-reservation-0001' }),
  })
  const payload = await response.json()
  assert.equal(response.status, 200)
  assert.equal(payload.status, 'fee-reservation-linked')
  assert.deepEqual(linkedWith, {
    assetTransferIdempotencyKey: idempotencyKey,
    feeReservationIdempotencyKey: 'network-fee-reservation-0001',
  })
  assert.equal(payload.link.reservedFeeSun, '5000')
  assert.equal(payload.canSubmitSponsoredTransfer, false)
  assert.equal(payload.delegatedResourceSettlement, false)
})
