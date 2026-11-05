import test from 'node:test'
import assert from 'node:assert/strict'
import {
  connectTronLinkMainnet,
  discoverTronLink,
  readTronLinkMainnetContext,
  requestTronLinkAccounts,
  subscribeTronLink,
} from '../src/lib/tronlink-wallet.mjs'

const address = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'

function makeProvider({ host = 'https://api.trongrid.io', account = address } = {}) {
  const listeners = new Map()
  const provider = {
    isTronLink: true,
    request: async ({ method }) => method === 'eth_requestAccounts' ? [account] : { code: 200 },
    tronWeb: {
      ready: true,
      defaultAddress: { base58: account },
      fullNode: { host },
      trx: { signMessageV2: async () => '0x' + 'a'.repeat(130) },
    },
    on(event, listener) {
      const set = listeners.get(event) || new Set()
      set.add(listener)
      listeners.set(event, set)
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener)
    },
    emit(event, value) {
      for (const listener of listeners.get(event) || []) listener(value)
    },
    listeners,
  }
  return provider
}

function makeWindow(provider, info = { name: 'TronLink', rdns: 'org.tronlink.www' }) {
  const listeners = new Map()
  return {
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
      if (event.type === 'TIP6963:requestProvider') {
        for (const listener of listeners.get('TIP6963:announceProvider') || []) {
          listener({ detail: { info, provider } })
        }
      }
      return true
    },
  }
}

test('TIP-6963 discovery selects the TronLink announced provider', async () => {
  const provider = makeProvider()
  const discovered = await discoverTronLink(makeWindow(provider), 20)
  assert.equal(discovered, provider)
})

test('account authorization uses eth_requestAccounts and falls back only when unsupported', async () => {
  const calls = []
  const provider = {
    isTronLink: true,
    async request({ method }) {
      calls.push(method)
      if (method === 'eth_requestAccounts') throw Object.assign(new Error('unsupported method'), { code: 4200 })
      return { code: 200 }
    },
  }
  const response = await requestTronLinkAccounts(provider)
  assert.deepEqual(calls, ['eth_requestAccounts', 'tron_requestAccounts'])
  assert.equal(response.code, 200)
})

test('Mainnet context requires a valid address and the approved HTTPS TronGrid endpoint', () => {
  const provider = makeProvider()
  const context = readTronLinkMainnetContext(provider)
  assert.equal(context.address, address)
  assert.equal(context.network, 'mainnet')
  assert.equal(context.nodeUrl, 'https://api.trongrid.io')

  assert.throws(
    () => readTronLinkMainnetContext(makeProvider({ host: 'https://nile.trongrid.io' })),
    /requires TRON Mainnet/,
  )
  assert.throws(
    () => readTronLinkMainnetContext(makeProvider({ host: 'http://api.trongrid.io' })),
    /requires TRON Mainnet/,
  )
})

test('connect requests authorization and confirms the active address matches the wallet response', async () => {
  const provider = makeProvider()
  const context = await connectTronLinkMainnet({ windowRef: makeWindow(provider), timeoutMs: 20 })
  assert.equal(context.provider, provider)
  assert.equal(context.address, address)

  const mismatched = makeProvider({ account: 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2' })
  mismatched.request = async () => [address]
  await assert.rejects(
    () => connectTronLinkMainnet({ windowRef: makeWindow(mismatched), timeoutMs: 20 }),
    /does not match its active TronWeb account/,
  )
})

test('wallet account, network and disconnect events can be unsubscribed', () => {
  const provider = makeProvider()
  const events = []
  const unsubscribe = subscribeTronLink(provider, {
    onAccountsChanged: (value) => events.push(['accountsChanged', value]),
    onChainChanged: (value) => events.push(['chainChanged', value]),
    onDisconnect: (value) => events.push(['disconnect', value]),
  })
  provider.emit('accountsChanged', [address])
  provider.emit('chainChanged', '0x2b6653dc')
  provider.emit('disconnect', { code: 4900 })
  assert.deepEqual(events.map(([name]) => name), ['accountsChanged', 'chainChanged', 'disconnect'])
  unsubscribe()
  assert.equal(provider.listeners.get('accountsChanged').size, 0)
  assert.equal(provider.listeners.get('chainChanged').size, 0)
  assert.equal(provider.listeners.get('disconnect').size, 0)
})
