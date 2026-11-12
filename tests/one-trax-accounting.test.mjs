import test from 'node:test'
import assert from 'node:assert/strict'
import { readOneTraxAccounting } from '../server/one-trax-accounting.mjs'

const validAddress = 'T' + 'A'.repeat(33)

test('1TRAX accounting keeps native TRX reserve and token liability in separate fields', async () => {
  let host = ''
  const fake = {
    trx: { getBalance: async () => '150000000' },
    contract: () => ({ at: async () => ({
      totalSupply: () => ({ call: async () => '100000000' }),
      decimals: () => ({ call: async () => 6 }),
    }) }),
  }
  const result = await readOneTraxAccounting({
    env: { ONE_TRAX_NETWORK: 'nile', ONE_TRAX_RESERVE_ADDRESS: validAddress, ONE_TRAX_CONTRACT_ADDRESS: validAddress },
    tronWebFactory: (url) => { host = url; return fake },
  })
  assert.equal(host, 'https://nile.trongrid.io')
  assert.equal(result.reserve.balanceSun, '150000000')
  assert.equal(result.reserve.asset, 'native-TRX')
  assert.equal(result.liability.totalSupplyUnits, '100000000')
  assert.equal(result.liability.asset, '1TRAX')
  assert.equal(result.reconciliation.surplusSun, '50000000')
  assert.equal(result.reconciliation.shortfallSun, '0')
})

test('1TRAX accounting refuses Mainnet and never falls back to a Mainnet endpoint', async () => {
  let called = false
  const result = await readOneTraxAccounting({
    env: { ONE_TRAX_NETWORK: 'mainnet', ONE_TRAX_RESERVE_ADDRESS: validAddress, ONE_TRAX_CONTRACT_ADDRESS: validAddress },
    tronWebFactory: () => { called = true; throw new Error('must not be called') },
  })
  assert.equal(result.configured, false)
  assert.equal(called, false)
  assert.ok(result.missing.includes('ONE_TRAX_NETWORK (nile or shasta)'))
})
