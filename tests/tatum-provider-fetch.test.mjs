import test from 'node:test'
import assert from 'node:assert/strict'
import { createTatumProviderFetch } from '../server/tatum-provider-fetch.mjs'

test('paces Tatum REST and TRON gateway origins on one shared queue', async () => {
  let clock = 0
  const starts = []
  const fetch = createTatumProviderFetch({
    fetchImpl: async (input) => { starts.push({ url: String(input), at: clock }); return { ok: true } },
    minimumIntervalMs: 400,
    now: () => clock,
    sleep: async (ms) => { clock += ms },
  })
  await Promise.all([
    fetch('https://api.tatum.io/v4/data/blockchains/block/current?chain=tron-mainnet'),
    fetch('https://tron-nile.gateway.tatum.io/walletsolidity/getnowblock'),
    fetch('https://tron-shasta.gateway.tatum.io/walletsolidity/getnowblock'),
    fetch('https://tron-mainnet.gateway.tatum.io/walletsolidity/getnowblock'),
  ])
  assert.deepEqual(starts.map((item) => item.at), [0, 400, 800, 1200])
})

test('does not throttle unrelated hosts or alter request arguments', async () => {
  const calls = []
  const init = { method: 'POST', body: '{}' }
  const fetch = createTatumProviderFetch({
    fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true } },
    minimumIntervalMs: 5000,
  })
  await Promise.all([fetch('https://example.com/one', init), fetch('https://example.com/two', init)])
  assert.equal(calls.length, 2)
  assert.equal(calls[0].options, init)
  assert.equal(calls[1].options, init)
})
