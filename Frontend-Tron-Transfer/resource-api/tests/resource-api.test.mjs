import test from 'node:test'
import assert from 'node:assert/strict'
import { isMainnetAddress, summarizeResources } from '../server.js'

test('accepts TRON Base58 addresses and rejects malformed or non-TRON addresses', () => {
  assert.equal(isMainnetAddress('TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'), true)
  assert.equal(isMainnetAddress('0x' + '1'.repeat(40)), false)
  assert.equal(isMainnetAddress('not-a-wallet'), false)
  assert.equal(isMainnetAddress('T' + '0'.repeat(33)), false)
  assert.equal(isMainnetAddress('TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'), true)
  assert.equal(isMainnetAddress('TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL'), true)
})

test('calculates free Bandwidth, staked/delegated Bandwidth, and Energy separately', () => {
  const result = summarizeResources({
    freeNetLimit: 600, freeNetUsed: 120,
    NetLimit: 1500, NetUsed: 320,
    EnergyLimit: 100000, EnergyUsed: 25000,
  }, { balance: 1234567 }, [
    { key: 'getEnergyFee', value: 100 },
    { key: 'getTransactionFee', value: 1000 },
    { key: 'getMaxFeeLimit', value: 15000000000 },
  ])
  assert.deepEqual(result.bandwidth, {
    freeAvailable: 480, freeLimit: 600, freeUsed: 120,
    stakedOrDelegatedAvailable: 1180, stakedOrDelegatedLimit: 1500,
    stakedOrDelegatedUsed: 320, totalAvailable: 1660,
  })
  assert.deepEqual(result.energy, {
    available: 75000, limit: 100000, used: 25000,
    protocolFreeQuota: 0, source: 'staked-or-delegated',
  })
  assert.equal(result.chainParameters.energyFeeSunPerUnit, 100)
  assert.equal(result.chainParameters.bandwidthFeeSunPerByte, 1000)
  assert.equal(result.chainParameters.maxFeeLimitSun, 15000000000)
  assert.equal(result.freeEnergyAvailable, false)
  assert.equal(result.exactDeploymentEnergyEstimate, null)
})

test('treats omitted protobuf numeric values as zero and never reports negative resources', () => {
  const result = summarizeResources({ EnergyUsed: 1, freeNetUsed: 99, NetUsed: 3 }, {}, [])
  assert.equal(result.energy.available, 0)
  assert.equal(result.bandwidth.freeAvailable, 0)
  assert.equal(result.bandwidth.stakedOrDelegatedAvailable, 0)
  assert.equal(result.balanceSun, '0')
})


test('free-delegation route is Mainnet-wallet restricted and returns injected live status', async (t) => {
  const { createServer } = await import('../server.js')
  const expected = {
    success: true,
    network: 'mainnet',
    status: 'mainnet-resource-snapshot-read',
    address: 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp',
    resourceRead: true,
    policy: { mode: 'free-delegation', walletApprovalRequired: true },
    transactionActions: { unsignedTransactionCreated: false, walletSignatureRequested: false, transactionBroadcast: false },
  }
  let calls = 0
  const server = createServer({
    allowedAddress: expected.address,
    readFreeDelegationStatus: async (address, options) => {
      calls += 1
      assert.equal(address, expected.address)
      assert.equal(options.refresh, true)
      return expected
    },
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const base = 'http://127.0.0.1:' + server.address().port
  const allowed = await fetch(base + '/api/tron/resources/free-delegation/status?address=' + expected.address + '&refresh=1')
  assert.equal(allowed.status, 200)
  assert.deepEqual(await allowed.json(), expected)
  const denied = await fetch(base + '/api/tron/resources/free-delegation/status?address=TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL')
  assert.equal(denied.status, 403)
  assert.equal(calls, 1)
})
