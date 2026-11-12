import test from 'node:test'
import assert from 'node:assert/strict'
import { createPublicTronReadClient } from '../server/public-tron-read-client.mjs'

const ADDRESS = 'TLBWTZHjjRMwbFgKgqmLwjp4ZKjxt5a2GT'
const TXID = 'a'.repeat(64)

function fakeFetchFor(payloads) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    const path = new URL(url).pathname
    const value = payloads[path] ?? {}
    return { ok: true, status: 200, json: async () => value }
  }
  return { fetchImpl, calls }
}

test('public TRON adapter reads solidified native TRX balance and account permission state in SUN', async () => {
  const { fetchImpl, calls } = fakeFetchFor({
    '/walletsolidity/getaccount': { address: ADDRESS, balance: 6200000000, owner_permission: { threshold: 1, keys: [{ address: ADDRESS, weight: 1 }] }, active_permission: [{ id: 2, threshold: 1, keys: [{ address: ADDRESS, weight: 1 }], operations: '02' + '00'.repeat(31) }] },
  })
  const client = createPublicTronReadClient({ fetchImpl })
  const account = await client.getSolidifiedAccount(ADDRESS)
  assert.equal(account.balanceSun, '6200000000')
  assert.equal(account.balanceTrx, '6200')
  assert.equal(account.spendableBalanceOnly, true)
  assert.equal(account.restrictedEscrowBalance, null)
  assert.equal(account.permissionAssessment.available, true)
  assert.equal(account.permissionAssessment.singleSignerCanMoveNativeTrx, true)
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /walletsolidity\/getaccount$/)
})

test('public TRON adapter queries solidified resource usage', async () => {
  const { fetchImpl } = fakeFetchFor({
    '/wallet/getaccountresource': {
      freeNetLimit: 600, freeNetUsed: 100, NetLimit: 900, NetUsed: 250,
      EnergyLimit: 5000, EnergyUsed: 1250,
    },
  })
  const client = createPublicTronReadClient({ fetchImpl })
  const result = await client.getAccountResources(ADDRESS)
  assert.equal(result.freeBandwidthRemaining, 500)
  assert.equal(result.stakedBandwidthRemaining, 650)
  assert.equal(result.energyRemaining, 3750)
})

test('transaction lookup checks both solidified body and receipt', async () => {
  const { fetchImpl, calls } = fakeFetchFor({
    '/walletsolidity/gettransactionbyid': { txID: TXID, raw_data: {} },
    '/walletsolidity/gettransactioninfobyid': { id: TXID, blockNumber: 123, receipt: { result: 'SUCCESS' } },
  })
  const client = createPublicTronReadClient({ fetchImpl })
  const result = await client.getSolidifiedTransaction(TXID)
  assert.equal(result.found, true)
  assert.equal(result.solidifiedReceiptFound, true)
  assert.equal(calls.length, 2)
})

test('rejects malformed addresses and transaction IDs', async () => {
  const client = createPublicTronReadClient({ fetchImpl: async () => { throw new Error('should not fetch') } })
  await assert.rejects(client.getSolidifiedAccount('not-an-address'), (error) => error.status === 400)
  await assert.rejects(client.getSolidifiedTransaction('bad'), (error) => error.status === 400)
})

test('rejects unapproved API origins to prevent server-side request forgery', () => {
  assert.throws(() => createPublicTronReadClient({ origin: 'https://attacker.example' }),
    /approved HTTPS TronGrid origin/)
})

test('public API adapter exposes no transaction submission or signing methods', () => {
  const client = createPublicTronReadClient({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }) })
  assert.equal(client.broadcastTransaction, undefined)
  assert.equal(client.signTransaction, undefined)
  assert.equal(client.createTransaction, undefined)
})

test('public TRON adapter runs read-only contract calls against solidified state', async () => {
  const { fetchImpl, calls } = fakeFetchFor({
    '/walletsolidity/triggerconstantcontract': {
      result: { result: true },
      constant_result: ['0'.repeat(63) + '1'],
    },
  })
  const client = createPublicTronReadClient({ fetchImpl })
  const result = await client.triggerSolidifiedConstantContract({
    contractAddress: ADDRESS,
    functionSelector: 'totalLockedSun()',
    parameter: '',
    ownerAddress: ADDRESS,
  })
  assert.equal(result.resultHex, '0'.repeat(63) + '1')
  assert.match(calls[0].url, /walletsolidity\/triggerconstantcontract$/)
  assert.equal(JSON.parse(calls[0].init.body).function_selector, 'totalLockedSun()')
})

test('solidified contract reader rejects malformed selectors and ABI parameters', async () => {
  const client = createPublicTronReadClient({ fetchImpl: async () => { throw new Error('should not fetch') } })
  await assert.rejects(client.triggerSolidifiedConstantContract({
    contractAddress: ADDRESS, functionSelector: 'fundPosition;drop()', parameter: '', ownerAddress: ADDRESS,
  }), (error) => error.status === 400)
  await assert.rejects(client.triggerSolidifiedConstantContract({
    contractAddress: ADDRESS, functionSelector: 'getPosition(bytes32)', parameter: 'xyz', ownerAddress: ADDRESS,
  }), (error) => error.status === 400)
})

test('public TRON read client retrieves contract runtime bytecode for audit pinning', async () => {
  const { fetchImpl, calls } = fakeFetchFor({
    '/wallet/getcontractinfo': {
      runtimecode: '60016000',
      smart_contract: { code_hash: 'abcd' },
    },
  })
  const client = createPublicTronReadClient({ fetchImpl })
  const result = await client.getContractRuntimeCode(ADDRESS)
  assert.equal(result.runtimeCode, '60016000')
  assert.equal(result.providerCodeHash, 'abcd')
  assert.match(calls[0].url, /wallet\/getcontractinfo$/)
})

test('contract runtime lookup rejects addresses and empty bytecode', async () => {
  const client = createPublicTronReadClient({
    fetchImpl: async () => ({ ok: true, json: async () => ({ runtimecode: '' }) }),
  })
  await assert.rejects(client.getContractRuntimeCode('bad-address'), (error) => error.status === 400)
  await assert.rejects(client.getContractRuntimeCode(ADDRESS), /runtime bytecode/)
})
