import test from 'node:test'
import assert from 'node:assert/strict'
import { discoverTronLinkProvider, isTronWalletProvider, requestTronLinkConnection } from '../src/tronlink-provider.mjs'

function makeProvider({ method = 'tron_requestAccounts', address = 'T' + '2'.repeat(33) } = {}) {
  const calls = []
  const tronWeb = {
    ready: true,
    defaultAddress: { base58: address },
    isAddress: value => typeof value === 'string' && /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value),
    trx: { sign: async () => { throw new Error('sign must not be called during connection') } },
  }
  return {
    calls,
    tronWeb,
    isTronLink: true,
    request: async ({ method: requested }) => {
      calls.push(requested)
      if (requested !== method) {
        const error = new Error('method not found')
        error.code = -32601
        throw error
      }
      return [address]
    },
  }
}

test('accepts any injected TRON provider exposing request and TronWeb signer', () => {
  const provider = makeProvider()
  assert.equal(isTronWalletProvider(provider), true)
})

test('rejects EVM-only providers without a TRON signer', () => {
  assert.equal(isTronWalletProvider({ request: async () => [] }), false)
})

test('discovers a supported wallet from common injection globals', async () => {
  const provider = makeProvider()
  assert.equal(await discoverTronLinkProvider({ okxwallet: { tronLink: provider } }), provider)
})

test('authorizes a wallet using the TRON account method and returns its signer', async () => {
  const provider = makeProvider()
  const result = await requestTronLinkConnection(provider, {})
  assert.equal(result.address, provider.tronWeb.defaultAddress.base58)
  assert.equal(result.tronWeb, provider.tronWeb)
  assert.deepEqual(provider.calls, ['tron_requestAccounts'])
})

test('falls back to eth_requestAccounts only when the TRON method is unsupported', async () => {
  const provider = makeProvider({ method: 'eth_requestAccounts' })
  const result = await requestTronLinkConnection(provider, {})
  assert.equal(result.address, provider.tronWeb.defaultAddress.base58)
  assert.deepEqual(provider.calls, ['tron_requestAccounts', 'eth_requestAccounts'])
})

test('connection does not call the wallet transaction signer', async () => {
  const provider = makeProvider()
  await requestTronLinkConnection(provider, {})
  assert.equal(provider.calls.length, 1)
})
