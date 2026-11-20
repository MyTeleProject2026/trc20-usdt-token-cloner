import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTokenUnits, formatTokenUnits, addressesEqual, parseBatchCreditRows, callMainnetView, calculateDeploymentResourceBudget, normalizeDeploymentEnergyEstimate, isMainnetEnergyEstimateUnavailable, deployContractFromTronLink } from '../src/trax-mainnet.mjs'
import { MAINNET_ACTION_CONTROLS_KEY, MAINNET_ACTION_DEFAULTS } from '../src/mainnet-action-controls.mjs'

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

test('zero-TRX preflight accepts a single Bandwidth source that covers the full transaction', () => {
  const budget = calculateDeploymentResourceBudget({
    energyRequired: '100000',
    rawDataHex: '6001600055',
    feeLimitSun: '150000000',
    resourceSnapshot: {
      energyFeeSun: '100',
      bandwidthFeeSun: '1000',
      energyAvailable: '125000',
      freeBandwidthAvailable: '150',
      stakedBandwidthAvailable: '100',
      maxFeeLimitSun: '15000000000',
    },
  })
  assert.equal(budget.estimatedBandwidthBytes, '139')
  assert.equal(budget.availableBandwidth, '150')
  assert.equal(budget.bandwidthShortfall, '0')
  assert.equal(budget.requiredTrxSun, '0')
})

test('zero-TRX preflight does not pool free and staked Bandwidth for one transaction', () => {
  assert.throws(() => calculateDeploymentResourceBudget({
    energyRequired: '100000',
    rawDataHex: '6001600055',
    feeLimitSun: '150000000',
    resourceSnapshot: {
      energyFeeSun: '100',
      bandwidthFeeSun: '1000',
      energyAvailable: '125000',
      freeBandwidthAvailable: '80',
      stakedBandwidthAvailable: '100',
      maxFeeLimitSun: '15000000000',
    },
  }), /total 0[.]139000 TRX.*No wallet prompt, signature, or broadcast was attempted/)
})

test('zero-TRX preflight blocks the exact Bandwidth quota shortfall before signing', () => {
  assert.throws(() => calculateDeploymentResourceBudget({
    energyRequired: '100000',
    rawDataHex: '6001600055',
    feeLimitSun: '150000000',
    resourceSnapshot: {
      energyFeeSun: '100',
      bandwidthFeeSun: '1000',
      energyAvailable: '125000',
      freeBandwidthAvailable: '60',
      stakedBandwidthAvailable: '40',
      maxFeeLimitSun: '15000000000',
    },
  }), /total 0[.]139000 TRX.*No wallet prompt, signature, or broadcast was attempted/)
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
  }), /ZERO-TRX-BURN PROTECTION BLOCKED DEPLOYMENT.*total 12\.639000 TRX.*No wallet prompt/)
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
  }), /ZERO-TRX-BURN PROTECTION BLOCKED DEPLOYMENT.*total 12\.639000 TRX.*No wallet prompt/)
})

test('Mainnet deployment estimator accepts a successful estimateenergy response and preserves its penalty', () => {
  assert.deepEqual(normalizeDeploymentEnergyEstimate({
    result: { result: true },
    energy_required: 2400000,
    energy_penalty: 125000,
  }), {
    energyUsed: '2400000',
    energyPenalty: '125000',
  })
})

test('Mainnet deployment simulation accepts triggerconstantcontract energy_used response', () => {
  assert.deepEqual(normalizeDeploymentEnergyEstimate({
    result: { result: true },
    energy_used: '1850000',
    energy_penalty: '50000',
    transaction: { ret: [{ ret: 'SUCESS', contractRet: 'SUCCESS' }] },
  }), {
    energyUsed: '1850000',
    energyPenalty: '50000',
  })
})

test('Mainnet deployment estimator rejects failed execution, missing, malformed, and zero Energy', () => {
  assert.throws(() => normalizeDeploymentEnergyEstimate({ result: { result: false }, energy_required: 100 }), /estimation failed/)
  assert.throws(() => normalizeDeploymentEnergyEstimate({
    result: { result: true }, energy_required: 100,
    transaction: { ret: [{ contractRet: 'REVERT' }] },
  }), /did not execute successfully/)
  assert.throws(() => normalizeDeploymentEnergyEstimate({ result: { result: true } }), /valid energy_required/)
  assert.throws(() => normalizeDeploymentEnergyEstimate({ result: { result: true }, energy_required: 'not-a-number' }), /valid energy_required/)
  assert.throws(() => normalizeDeploymentEnergyEstimate({ result: { result: true }, energy_required: '0' }), /returned zero Energy/)
  assert.throws(() => normalizeDeploymentEnergyEstimate({ result: { result: true }, energy_required: '100', energy_penalty: '-1' }), /invalid Energy penalty/)
})

test('only explicit unsupported estimateenergy responses are eligible for simulation fallback', () => {
  assert.equal(isMainnetEnergyEstimateUnavailable(new Error('HTTP 404 for /wallet/estimateenergy')), true)
  assert.equal(isMainnetEnergyEstimateUnavailable(new Error('does not support estimate energy')), true)
  assert.equal(isMainnetEnergyEstimateUnavailable(new Error('TRON Mainnet deployment Energy estimation failed: OUT_OF_ENERGY')), false)
  assert.equal(isMainnetEnergyEstimateUnavailable(new Error('HTTP 401 for /wallet/estimateenergy')), false)
})

test('deployment budget applies a 25 percent Energy margin and keeps Bandwidth source separate', () => {
  const budget = calculateDeploymentResourceBudget({
    energyRequired: '2000000',
    rawDataHex: '60'.repeat(200),
    feeLimitSun: '300000000',
    resourceSnapshot: {
      energyFeeSun: '100',
      bandwidthFeeSun: '1000',
      energyAvailable: '2500000',
      freeBandwidthAvailable: '1000',
      stakedBandwidthAvailable: '2000',
      maxFeeLimitSun: '15000000000',
    },
  })
  assert.equal(budget.energyWithSafetyMargin, '2500000')
  assert.equal(budget.energyShortfall, '0')
  assert.equal(budget.estimatedBandwidthBytes, '334')
  assert.equal(budget.availableBandwidth, '2000')
  assert.equal(budget.bandwidthShortfall, '0')
  assert.equal(budget.requiredTrxSun, '0')
})

test('deployment execution switch blocks direct deployment before wallet access', async () => {
  const previous = globalThis.localStorage
  const values = new Map([[MAINNET_ACTION_CONTROLS_KEY, JSON.stringify({ ...MAINNET_ACTION_DEFAULTS, deploymentExecution: false })]])
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  }
  try {
    await assert.rejects(
      deployContractFromTronLink(null, {}, 'TRӾ', 150000000),
      /disabled in Owner Settings \(deploymentExecution\)/,
    )
  } finally {
    if (previous === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previous
  }
})
