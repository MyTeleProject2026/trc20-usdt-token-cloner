import test from 'node:test'
import assert from 'node:assert/strict'
import { readOneTraxAccounting } from '../server/one-trax-accounting.mjs'

const validAddress = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'

test('1TRAX accounting keeps native TRX reserve and token liability in separate fields', async () => {
  let host = ''
  const fake = {
    trx: { raw: { getBalance: async () => '150000000' } },
    contract: () => ({ at: async () => ({
      totalSupply: () => ({ call: async () => '100000000' }),
      decimals: () => ({ call: async () => 6 }),
    }) }),
  }
  const result = await readOneTraxAccounting({
    env: { ONE_TRAX_RESERVE_ADDRESS: validAddress, ONE_TRAX_CONTRACT_ADDRESS: validAddress },
    tronWebFactory: (url) => { host = url; return fake },
  })
  assert.equal(host, 'https://api.trongrid.io')
  assert.equal(result.reserve.balanceSun, '150000000')
  assert.equal(result.reserve.asset, 'native-TRX')
  assert.equal(result.liability.totalSupplyUnits, '100000000')
  assert.equal(result.liability.asset, 'TRX (TRӾ token; not native TRX)')
  assert.equal(result.reconciliation.surplusSun, '50000000')
  assert.equal(result.reconciliation.shortfallSun, '0')
})

test('TRӾ accounting uses Mainnet only', async () => {
  let called = false
  const result = await readOneTraxAccounting({
    env: { ONE_TRAX_RESERVE_ADDRESS: validAddress, ONE_TRAX_CONTRACT_ADDRESS: validAddress },
    tronWebFactory: () => { called = true; return { trx: { raw: { getBalance: async () => '0' } }, contract: () => ({ at: async () => ({ totalSupply: () => ({ call: async () => '0' }), decimals: () => ({ call: async () => 6 }) }) }) } },
  })
  assert.equal(result.configured, true)
  assert.equal(result.network, 'mainnet')
  assert.equal(called, true)
})
