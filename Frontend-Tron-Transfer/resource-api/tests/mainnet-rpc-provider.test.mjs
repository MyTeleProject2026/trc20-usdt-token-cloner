import test from 'node:test'
import assert from 'node:assert/strict'
import { createMainnetRpcProvider, createMainnetTronWeb, postMainnetRead } from '../mainnet-rpc-provider.mjs'
import { providers } from 'tronweb'
import { readFile } from 'node:fs/promises'

const owner = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const env = {
  TATUM_API_KEY: 'tatum-server-only-test-key',
  TATUM_TRON_NETWORK: 'mainnet',
  TATUM_TRON_RPC_URL: 'https://tron-mainnet.gateway.tatum.io',
  TRONGRID_API_KEY: 'trongrid-server-only-test-key',
}

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

test('allowlisted Mainnet reads prefer Tatum and keep both provider keys server-side', async () => {
  const calls = []
  const provider = createMainnetRpcProvider({
    env,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), headers: options.headers })
      return jsonResponse({ address: '41' + '11'.repeat(20), balance: '35501899' })
    },
  })
  const result = await provider.request('/wallet/getaccount', { address: owner, visible: true }, 'post')
  assert.equal(result.balance, '35501899')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://tron-mainnet.gateway.tatum.io/wallet/getaccount')
  assert.equal(calls[0].headers['x-api-key'], env.TATUM_API_KEY)
  assert.equal(calls[0].headers['TRON-PRO-API-KEY'], undefined)
})

test('Tatum read failures fall back to TronGrid with unchanged request semantics', async () => {
  const calls = []
  const provider = createMainnetRpcProvider({
    env,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), body: options.body, headers: options.headers })
      if (String(url).startsWith('https://tron-mainnet.gateway.tatum.io/')) {
        return jsonResponse({ Error: 'temporary Tatum failure' }, 503)
      }
      return jsonResponse({ address: '41' + '22'.repeat(20), balance: '7' })
    },
  })
  const payload = { address: owner, visible: true }
  const result = await provider.request('/wallet/getaccount', payload, 'post')
  assert.equal(result.balance, '7')
  assert.equal(calls.length, 2)
  assert.deepEqual(JSON.parse(calls[0].body), payload)
  assert.deepEqual(JSON.parse(calls[1].body), payload)
  assert.equal(calls[1].url, 'https://api.trongrid.io/wallet/getaccount')
  assert.equal(calls[1].headers['TRON-PRO-API-KEY'], env.TRONGRID_API_KEY)
  assert.equal(calls[1].headers['x-api-key'], undefined)
})

test('transaction construction and signed broadcasts are always routed to TronGrid', async () => {
  const calls = []
  const provider = createMainnetRpcProvider({
    env,
    fetchImpl: async (url, options) => {
      calls.push(String(url))
      return jsonResponse({ result: true })
    },
  })
  await provider.request('/wallet/deploycontract', { owner_address: owner }, 'post')
  await provider.request('/wallet/broadcasttransaction', { txID: 'a'.repeat(64) }, 'post')
  assert.deepEqual(calls, [
    'https://api.trongrid.io/wallet/deploycontract',
    'https://api.trongrid.io/wallet/broadcasttransaction',
  ])
})

test('Tatum is disabled outside the configured Mainnet network', async () => {
  const calls = []
  const provider = createMainnetRpcProvider({
    env: { ...env, TATUM_TRON_NETWORK: 'nile' },
    fetchImpl: async url => {
      calls.push(String(url))
      return jsonResponse({ balance: '1' })
    },
  })
  await provider.request('/wallet/getaccount', { address: owner }, 'post')
  assert.deepEqual(calls, ['https://api.trongrid.io/wallet/getaccount'])
})

test('shared TronWeb instances use custom Mainnet providers and retain TronGrid event connectivity', () => {
  const client = createMainnetTronWeb({ env, fetchImpl: async () => jsonResponse({}) })
  assert.ok(client.fullNode instanceof providers.HttpProvider)
  assert.ok(client.solidityNode instanceof providers.HttpProvider)
  assert.equal(client.fullNode.host, 'https://api.trongrid.io')
  assert.equal(client.eventServer.host, 'https://api.trongrid.io')
})

test('standalone solidified reads use the same Tatum-first fallback policy', async () => {
  const calls = []
  const result = await postMainnetRead('/walletsolidity/gettransactioninfobyid', { value: 'a'.repeat(64) }, {
    env,
    fetchImpl: async url => {
      calls.push(String(url))
      return jsonResponse({ id: 'a'.repeat(64), blockNumber: 1 })
    },
  })
  assert.equal(result.blockNumber, 1)
  assert.equal(calls[0], 'https://tron-mainnet.gateway.tatum.io/walletsolidity/gettransactioninfobyid')
})


test('Owner, TRӾ deployment and Sponsor engines share the Tatum-first read provider and TronGrid-only broadcast adapter', async () => {
  const [owner, deployment, sponsor] = await Promise.all([
    readFile(new URL('../owner-operation-api.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../trax-deployment-api.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../sponsor-engine.mjs', import.meta.url), 'utf8'),
  ])
  for (const source of [owner, deployment, sponsor]) {
    assert.match(source, /createMainnetTronWeb/)
    assert.match(source, /sendRawTransaction/)
  }
  assert.match(owner, /createMainnetTronWeb\(\{ env, fetchImpl: pacedFetch \}\)/)
  assert.match(deployment, /createMainnetTronWeb\(\{ env, fetchImpl \}\)/)
  assert.match(sponsor, /createMainnetTronWeb\(\{ env, fetchImpl \}\)/)
  assert.match(owner, /broadcastTransaction = \(tronWeb, signed\) => tronWeb\.trx\.sendRawTransaction\(signed\)/)
  assert.match(deployment, /broadcastDeployment = \(client, signed\) => client\.trx\.sendRawTransaction\(signed\)/)
  assert.match(sponsor, /tronWeb\.trx\.sendRawTransaction\(signedTransaction\)/)
})
