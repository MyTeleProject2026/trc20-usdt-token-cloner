import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTokenUnits, formatTokenUnits, addressesEqual, parseBatchCreditRows, callMainnetView, calculateDeploymentResourceBudget, evaluateDeploymentFunding, normalizeMainnetAccountResources, normalizeDeploymentEnergyEstimate } from '../src/trax-mainnet.mjs'

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


test('Mainnet resource snapshot derives only currently unused Energy and both Bandwidth quotas', () => {
  const snapshot = normalizeMainnetAccountResources({
    EnergyLimit: 900000,
    EnergyUsed: 125000,
    freeNetLimit: 600,
    freeNetUsed: 125,
    NetLimit: 1200,
    NetUsed: 300,
  }, { chainParameter: [
    { key: 'getEnergyFee', value: 100 },
    { key: 'getTransactionFee', value: 1000 },
    { key: 'getMaxFeeLimit', value: 15000000000 },
  ] })
  assert.equal(snapshot.energyAvailable, '775000')
  assert.equal(snapshot.freeBandwidthAvailable, '475')
  assert.equal(snapshot.stakedBandwidthAvailable, '900')
  assert.equal(snapshot.energyFeeSun, '100')
  assert.equal(snapshot.bandwidthFeeSun, '1000')
  assert.equal(snapshot.maxFeeLimitSun, '15000000000')
})

test('Mainnet resource snapshot fails closed when critical fee parameters are absent', () => {
  assert.throws(() => normalizeMainnetAccountResources({
    EnergyLimit: 1000, EnergyUsed: 0, freeNetLimit: 100, freeNetUsed: 0,
    NetLimit: 100, NetUsed: 0,
  }, { chainParameter: [{ key: 'getTransactionFee', value: 1000 }] }), /valid current Energy fee/)
})

test('deployment Energy simulation rejects unsuccessful VM execution even with an estimate', () => {
  assert.throws(() => normalizeDeploymentEnergyEstimate({
    result: { result: true },
    energy_required: 900000,
    transaction: { ret: [{ ret: 'FAILED', contractRet: 'REVERT' }] },
  }), /simulation did not execute successfully/)
})

test('deployment Energy simulation rejects missing and zero estimates', () => {
  assert.throws(() => normalizeDeploymentEnergyEstimate({ result: { result: true } }), /valid energy_required/)
  assert.throws(() => normalizeDeploymentEnergyEstimate({ result: { result: true }, energy_required: 0 }), /returned zero Energy/)
})

test('deployment Energy simulation accepts successful estimate and preserves penalty', () => {
  assert.deepEqual(normalizeDeploymentEnergyEstimate({
    result: { result: true },
    energy_required: '800000',
    energy_penalty: '25000',
    transaction: { ret: [{ ret: 'SUCESS', contractRet: 'SUCCESS' }] },
  }), { energyUsed: '800000', energyPenalty: '25000' })
})


const ownerFundedTestBudget = {
  requiredTrxSun: '139000',
  energyBurnSun: '0',
  bandwidthBurnSun: '139000',
  feeLimitSun: '150000000',
}

test('owner-funded deployment permits resource shortfall only within explicit spend cap and balance', () => {
  const result = evaluateDeploymentFunding({
    resourceBudget: ownerFundedTestBudget,
    fundingMode: 'owner-funded',
    maxTrxSpendSun: '160000000',
    availableTrxSun: '200000000',
    reserveTrxSun: '1000000',
  })
  assert.equal(result.fundingMode, 'owner-funded')
  assert.equal(result.estimatedTrxFallbackSun, '139000')
  assert.equal(result.maximumPotentialTrxSpendSun, '150139000')
})

test('owner-funded deployment blocks when conservative maximum exceeds user spending cap', () => {
  assert.throws(() => evaluateDeploymentFunding({
    resourceBudget: ownerFundedTestBudget,
    fundingMode: 'owner-funded',
    maxTrxSpendSun: '150000000',
    availableTrxSun: '500000000',
  }), /exceeds your explicit spending cap/)
})

test('owner-funded deployment blocks when live TRX balance cannot cover maximum and reserve', () => {
  assert.throws(() => evaluateDeploymentFunding({
    resourceBudget: ownerFundedTestBudget,
    fundingMode: 'owner-funded',
    maxTrxSpendSun: '160000000',
    availableTrxSun: '150000000',
    reserveTrxSun: '1000000',
  }), /below the conservative maximum spend plus reserve/)
})

test('zero-TRX deployment mode continues to reject any resource fallback', () => {
  assert.throws(() => evaluateDeploymentFunding({
    resourceBudget: ownerFundedTestBudget,
    fundingMode: 'zero-trx',
    maxTrxSpendSun: '999999999',
    availableTrxSun: '500000000',
  }), /Zero-TRX deployment preflight blocked/)
})

test('owner-funded deployment rejects an unknown funding mode', () => {
  assert.throws(() => evaluateDeploymentFunding({
    resourceBudget: ownerFundedTestBudget,
    fundingMode: 'automatic',
    maxTrxSpendSun: '160000000',
    availableTrxSun: '500000000',
  }), /Unknown deployment funding mode/)
})
