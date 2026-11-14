import test from 'node:test'
import assert from 'node:assert/strict'
import {
  discoverTronLinkProvider,
  isTronLinkProvider,
  requestTronLinkConnection,
} from '../Frontend-Tron-Transfer/src/tronlink-provider.mjs'

function fakeWindow(initial = {}) {
  const listeners = new Map()
  return {
    ...initial,
    Event,
    addEventListener(name, listener) {
      const set = listeners.get(name) || new Set()
      set.add(listener)
      listeners.set(name, set)
    },
    removeEventListener(name, listener) {
      listeners.get(name)?.delete(listener)
    },
    dispatchEvent(event) {
      for (const listener of [...(listeners.get(event.type) || [])]) {
        listener(event)
      }
      return true
    },
  }
}

const ownerAddress = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'

test('TronLink provider discovery accepts a TIP-6963 announcement', async () => {
  const provider = { isTronLink: true, request: async () => [] }
  const win = fakeWindow()
  const discovered = discoverTronLinkProvider(win, { timeoutMs: 100 })
  win.dispatchEvent(Object.assign(new Event('TIP6963:announceProvider'), {
    detail: { info: { name: 'TronLink', rdns: 'org.tronlink.www' }, provider },
  }))
  assert.equal(await discovered, provider)
})

test('TronLink discovery falls back to the injected window.tron provider', async () => {
  const provider = { isTronLink: true, request: async () => [] }
  const win = fakeWindow({ tron: provider })
  assert.equal(await discoverTronLinkProvider(win), provider)
  assert.equal(isTronLinkProvider(provider), true)
})

test('connection waits for TronWeb signer readiness after account approval', async () => {
  const win = fakeWindow()
  const provider = {
    isTronLink: true,
    tronWeb: false,
    request: async ({ method }) => {
      assert.equal(method, 'tron_requestAccounts')
      setTimeout(() => {
        provider.tronWeb = {
          ready: true,
          defaultAddress: { base58: ownerAddress },
          isAddress: value => value === ownerAddress,
          trx: { sign: async () => ({}) },
        }
      }, 30)
      return [ownerAddress]
    },
  }
  const result = await requestTronLinkConnection(provider, win, {
    readyTimeoutMs: 300,
    pollIntervalMs: 10,
  })
  assert.equal(result.address, ownerAddress)
  assert.equal(result.tronWeb.defaultAddress.base58, ownerAddress)
})

test('connection falls back to the EVM account method only when TronLink authorization is unsupported', async () => {
  const calls = []
  const provider = {
    isTronLink: true,
    tronWeb: {
      ready: true,
      defaultAddress: { base58: ownerAddress },
      isAddress: value => value === ownerAddress,
      trx: { sign: async () => ({}) },
    },
    request: async ({ method }) => {
      calls.push(method)
      if (method === 'tron_requestAccounts') throw Object.assign(new Error('unsupported method'), { code: 4200 })
      return { code: 200 }
    },
  }
  const result = await requestTronLinkConnection(provider, fakeWindow(), {
    readyTimeoutMs: 100,
    pollIntervalMs: 5,
  })
  assert.equal(result.address, ownerAddress)
  assert.deepEqual(calls, ['tron_requestAccounts', 'eth_requestAccounts'])
})

test('connection explains user rejection without repeatedly prompting', async () => {
  let calls = 0
  const provider = {
    isTronLink: true,
    request: async () => {
      calls += 1
      throw Object.assign(new Error('User rejected'), { code: 4001 })
    },
  }
  await assert.rejects(
    requestTronLinkConnection(provider, fakeWindow()),
    /connection was rejected/i,
  )
  assert.equal(calls, 1)
})
