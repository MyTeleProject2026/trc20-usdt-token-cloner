import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTokenUnits, formatTokenUnits, addressesEqual, parseBatchCreditRows, callMainnetView, calculateDeploymentResourceBudget } from '../src/trax-mainnet.mjs'

test('TRӾ amount conversion preserves six decimal places exactly', () => {
  assert.equal(parseTokenUnits('100'), '100000000')
  assert.equal(parseTokenUnits('0.000001'), '1')
  assert.equal(parseTokenUnits('12.345678'), '12345678')
  assert.equal(formatTokenUnits('100000000'), '100')
  assert.equal(formatTokenUnits('12345678'), '12.345678')
})

test('TRӾ amount parser rejects invalid precision and non-positive values', () => {
  for (const value of ['', '0', '0.0', '-1', '1e3', '1.0000001', '01', 'NaN']) {
    assert.throws(() => parseTokenUnits(value))
  }
})

test('TRӾ address comparison normalizes TRON address forms', () => {
  const tronWeb = { address: { toHex: (value) => value.toLowerCase() } }
  assert.equal(
    addressesEqual(tronWeb, 'TABC', 'tabc'),
    true,
  )
})


test('batch credit parser handles newline-separated addresses and exact six-decimal amounts', () => {
  const parsed = parseBatchCreditRows('TAddress111111111111111111,12.5\r\nTAddress222222222222222222,0.000001\n', value => value.startsWith('T'))
  assert.deepEqual(parsed, {
    recipients: ['TAddress111111111111111111', 'TAddress222222222222222222'],
    amounts: ['12500000', '1'],
  })
})

test('batch credit parser rejects malformed rows, invalid addresses, and over-limit batches', () => {
  const validate = value => value.startsWith('T')
  assert.throws(() => parseBatchCreditRows('', validate))
  assert.throws(() => parseBatchCreditRows('TAddress111111111111111111', validate))
  assert.throws(() => parseBatchCreditRows('NotAnAddress,1', validate))
  assert.throws(() => parseBatchCreditRows('TAddress111111111111111111,0', validate))
  assert.throws(() => parseBatchCreditRows(Array.from({length: 51}, (_, i) => 'TAddress' + String(i).padStart(20, '0') + ',1').join('\n'), validate))
})

test('paced contract-view helper retries one HTTP 429 and returns the successful read', async () => {
  let calls = 0
  const value = await callMainnetView({
    call: async () => {
      calls += 1
      if (calls === 1) {
        const error = new Error('Request failed with status code 429')
        error.response = { status: 429, data: { Error: 'request rate exceeded' } }
        throw error
      }
      return 'ok'
    },
  })
  assert.equal(value, 'ok')
  assert.equal(calls, 2)
})


test('zero-TRX owner can pass preflight only when delegated/staked Energy and Bandwidth cover deployment', () => {
  const budget = calculateDeploymentResourceBudget({
    energyRequired: '100000',
    rawDataHex: '6001600055',
    feeLimitSun: '150000000',
    resourceSnapshot: {
      energyFeeSun: '100',
      bandwidthFeeSun: '1000',
      energyAvailable: '125000',
      freeBandwidthAvailable: '139',
      stakedBandwidthAvailable: '0',
            maxFeeLimitSun: '15000000000',
    },
  })
  assert.equal(budget.requiredTrxSun, '0')
  assert.equal(budget.energyShortfall, '0')
  assert.equal(budget.bandwidthShortfall, '0')
})

test('zero-TRX policy blocks resource shortfalls without reading native TRX balance', () => {
  assert.throws(() => calculateDeploymentResourceBudget({
    energyRequired: '100000',
    rawDataHex: '6001600055',
    feeLimitSun: '150000000',
    resourceSnapshot: {
      energyFeeSun: '100',
      bandwidthFeeSun: '1000',
      energyAvailable: '0',
      freeBandwidthAvailable: '0',
      stakedBandwidthAvailable: '0',
            maxFeeLimitSun: '15000000000',
    },
  }), /ZERO-TRX-BURN PROTECTION BLOCKED DEPLOYMENT.*12\.639000 TRX.*0\.000000 TRX.*No wallet prompt/)
})

test('zero-TRX policy blocks resource shortfalls independently of native TRX balance', () => {
  assert.throws(() => calculateDeploymentResourceBudget({
    energyRequired: '100000',
    rawDataHex: '6001600055',
    feeLimitSun: '150000000',
    resourceSnapshot: {
      energyFeeSun: '100',
      bandwidthFeeSun: '1000',
      energyAvailable: '0',
      freeBandwidthAvailable: '0',
      stakedBandwidthAvailable: '0',
            maxFeeLimitSun: '15000000000',
    },
  }), /ZERO-TRX-BURN PROTECTION BLOCKED DEPLOYMENT.*12\.639000 TRX.*20\.000000 TRX.*No wallet prompt/)
})
