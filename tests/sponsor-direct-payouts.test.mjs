import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import express from 'express'
import { createServer } from 'node:http'
import { TronWeb } from 'tronweb'
import {
  parseSponsorDirectUsdtAmount,
  calculateSponsorDirectAvailableBaseUnits,
  matchesSponsorDirectUnsignedTransaction,
  isSponsorDirectAutoRouteEligible,
  createSponsorDirectPayoutsRouter,
} from '../server/routes/sponsor-direct-payouts.mjs'
import { buildOwnerUsdtTransferParameter, MAINNET_USDT_CONTRACT } from '../server/routes/tron-owner-withdrawals.mjs'

const sponsorAddress = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'
const recipientAddress = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const requesterAddress = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
const tronWeb = new TronWeb({ fullHost: 'https://tron-mainnet.gateway.tatum.io' })

test('sponsor-direct USDT amount parser accepts exact six-decimal amounts', () => {
  assert.equal(parseSponsorDirectUsdtAmount('1'), '1000000')
  assert.equal(parseSponsorDirectUsdtAmount('12.340056'), '12340056')
  assert.equal(parseSponsorDirectUsdtAmount('0.000001'), '1')
  assert.throws(() => parseSponsorDirectUsdtAmount('0'))
  assert.throws(() => parseSponsorDirectUsdtAmount('0.0000001'))
  assert.throws(() => parseSponsorDirectUsdtAmount('-1'))
  assert.throws(() => parseSponsorDirectUsdtAmount('1e2'))
  assert.throws(() => parseSponsorDirectUsdtAmount(1))
})

test('automatic sponsor routing requires actual available USDT, mandate limits, daily capacity and verified fee coverage', () => {
  const eligible = {
    amountBaseUnits: '25000000',
    balanceBaseUnits: '100000000',
    reservedBaseUnits: '25000000',
    perPayoutLimitBaseUnits: '50000000',
    dailyLimitBaseUnits: '100000000',
    dailyUsedBaseUnits: '25000000',
    feeCoverage: true,
  }
  assert.equal(isSponsorDirectAutoRouteEligible(eligible), true)
  assert.equal(isSponsorDirectAutoRouteEligible({ ...eligible, balanceBaseUnits: '40000000' }), false)
  assert.equal(isSponsorDirectAutoRouteEligible({ ...eligible, reservedBaseUnits: '80000000' }), false)
  assert.equal(isSponsorDirectAutoRouteEligible({ ...eligible, perPayoutLimitBaseUnits: '20000000' }), false)
  assert.equal(isSponsorDirectAutoRouteEligible({ ...eligible, dailyUsedBaseUnits: '80000000' }), false)
  assert.equal(isSponsorDirectAutoRouteEligible({ ...eligible, feeCoverage: false }), false)
  assert.equal(isSponsorDirectAutoRouteEligible({ ...eligible, amountBaseUnits: 'not-an-integer' }), false)
})

test('sponsor-direct available balance subtracts reservations without going negative', () => {
  assert.equal(calculateSponsorDirectAvailableBaseUnits('100000000', '25000000'), '75000000')
  assert.equal(calculateSponsorDirectAvailableBaseUnits('1000000', '1000000'), '0')
  assert.equal(calculateSponsorDirectAvailableBaseUnits('1000000', '2000000'), '0')
  assert.throws(() => calculateSponsorDirectAvailableBaseUnits('-1', '0'))
  assert.throws(() => calculateSponsorDirectAvailableBaseUnits('1.2', '0'))
})

function unsignedTransfer(overrides = {}) {
  const amountBaseUnits = '25000000'
  const parameter = buildOwnerUsdtTransferParameter(recipientAddress, amountBaseUnits, tronWeb)
  const rawDataHex = 'deadbeef'
  return {
    txID: createHash('sha256').update(Buffer.from(rawDataHex, 'hex')).digest('hex'),
    raw_data_hex: rawDataHex,
    raw_data: {
      expiration: Date.now() + 5 * 60 * 1000,
      contract: [{
        type: 'TriggerSmartContract',
        parameter: {
          value: {
            owner_address: tronWeb.address.toHex(sponsorAddress),
            contract_address: tronWeb.address.toHex(MAINNET_USDT_CONTRACT),
            call_value: 0,
            data: 'a9059cbb' + parameter,
          },
        },
      }],
    },
    ...overrides,
  }
}

test('unsigned sponsor transaction must bind the sponsor, official token, recipient and amount', () => {
  const tx = unsignedTransfer()
  const intent = { sponsorAddress, recipientAddress, amountBaseUnits: '25000000', tronWeb }
  assert.equal(matchesSponsorDirectUnsignedTransaction(tx, intent), true)
  assert.equal(matchesSponsorDirectUnsignedTransaction(tx, { ...intent, sponsorAddress: requesterAddress }), false)
  assert.equal(matchesSponsorDirectUnsignedTransaction(tx, { ...intent, recipientAddress: requesterAddress }), false)
  assert.equal(matchesSponsorDirectUnsignedTransaction(tx, { ...intent, amountBaseUnits: '25000001' }), false)
})

test('unsigned sponsor transaction rejects malformed tx IDs, expired data and non-single-call payloads', () => {
  const intent = { sponsorAddress, recipientAddress, amountBaseUnits: '25000000', tronWeb }
  const valid = unsignedTransfer()
  assert.equal(matchesSponsorDirectUnsignedTransaction({ ...valid, txID: 'z'.repeat(64) }, intent), false)
  assert.equal(matchesSponsorDirectUnsignedTransaction({
    ...valid,
    raw_data: { ...valid.raw_data, expiration: Date.now() - 1000 },
  }, intent), false)
  assert.equal(matchesSponsorDirectUnsignedTransaction({
    ...valid,
    raw_data: { ...valid.raw_data, contract: [...valid.raw_data.contract, ...valid.raw_data.contract] },
  }, intent), false)
})

test('public sponsor-direct configuration allows a zero-balance requester but requires sponsor funding and signature', async (t) => {
  const app = express()
  app.use('/api/tron/sponsor-direct', createSponsorDirectPayoutsRouter({ env: {} }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))

  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/tron/sponsor-direct/config')
  const payload = await response.json()
  assert.equal(response.status, 200)
  assert.equal(payload.network, 'mainnet')
  assert.equal(payload.asset, 'USDT')
  assert.equal(payload.tokenContract, MAINNET_USDT_CONTRACT)
  assert.equal(payload.requesterWalletFundingRequired, false)
  assert.equal(payload.sponsorWalletFundingRequired, true)
  assert.equal(payload.sponsorWalletSignatureRequired, true)
  assert.equal(payload.requestIntakeEnabled, true)
  assert.equal(payload.requesterWalletFundingRequired, false)
  assert.equal(payload.payoutMode, 'sponsor-direct')
  assert.equal(payload.payoutExecution, 'conditional-on-approved-funded-sponsor')
  assert.equal(payload.sponsorApprovalRequired, true)
})
