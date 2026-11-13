import test from 'node:test'
import assert from 'node:assert/strict'
import { readOneTraxAccounting } from '../server/one-trax-accounting.mjs'

const validAddress = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'

function fakeTronWeb({ name = 'TRӾ', symbol = 'TRX', vault = validAddress, authorizedToken = validAddress } = {}) {
  return {
    trx: { raw: { getBalance: async () => '150000000' } },
    address: { toHex: (value) => value },
    contract: () => ({ at: async () => ({
      totalSupply: () => ({ call: async () => '100000000' }),
      decimals: () => ({ call: async () => 6 }),
      name: () => ({ call: async () => name }),
      symbol: () => ({ call: async () => symbol }),
      reserveVault: () => ({ call: async () => vault }),
      authorizedToken: () => ({ call: async () => authorizedToken }),
    }) }),
  }
}

test('TRӾ accounting separates native TRX reserve and token liability after verifying metadata and reciprocal vault link', async () => {
  let host = ''
  const result = await readOneTraxAccounting({
    env: { ONE_TRAX_RESERVE_ADDRESS: validAddress, ONE_TRAX_CONTRACT_ADDRESS: validAddress },
    tronWebFactory: (url) => { host = url; return fakeTronWeb() },
  })
  assert.equal(host, 'https://api.trongrid.io')
  assert.equal(result.reserve.balanceSun, '150000000')
  assert.equal(result.reserve.asset, 'native-TRX')
  assert.equal(result.reserve.authorizedToken, validAddress)
  assert.equal(result.liability.totalSupplyUnits, '100000000')
  assert.equal(result.liability.name, 'TRӾ')
  assert.equal(result.liability.symbol, 'TRX')
  assert.equal(result.liability.asset, 'TRX (TRӾ token; not native TRX)')
  assert.equal(result.reconciliation.surplusSun, '50000000')
  assert.equal(result.reconciliation.shortfallSun, '0')
})

test('TRӾ accounting uses Mainnet only', async () => {
  let called = false
  const result = await readOneTraxAccounting({
    env: { ONE_TRAX_RESERVE_ADDRESS: validAddress, ONE_TRAX_CONTRACT_ADDRESS: validAddress },
    tronWebFactory: (url) => { called = url === 'https://api.trongrid.io'; return fakeTronWeb() },
  })
  assert.equal(result.configured, true)
  assert.equal(result.network, 'mainnet')
  assert.equal(called, true)
})

test('TRӾ accounting rejects a token with mismatched metadata', async () => {
  const result = await readOneTraxAccounting({
    env: { ONE_TRAX_RESERVE_ADDRESS: validAddress, ONE_TRAX_CONTRACT_ADDRESS: validAddress },
    tronWebFactory: () => fakeTronWeb({ symbol: 'FAKE' }),
  })
  assert.deepEqual(result, { success: false, error: 'mainnet-token-metadata-or-vault-mismatch' })
})

test('TRӾ accounting rejects a vault linked to a different token', async () => {
  const result = await readOneTraxAccounting({
    env: { ONE_TRAX_RESERVE_ADDRESS: validAddress, ONE_TRAX_CONTRACT_ADDRESS: validAddress },
    tronWebFactory: () => fakeTronWeb({ authorizedToken: 'different-token' }),
  })
  assert.deepEqual(result, { success: false, error: 'mainnet-vault-token-authorization-mismatch' })
})
