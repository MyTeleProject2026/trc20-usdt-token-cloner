import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import express from 'express'
import { createChainTokenInspectionRouter } from '../server/routes/chain-token-inspection.mjs'

const contractAddress = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const ownerAddress = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'

async function withServer({ tronWebFactory, now } = {}, run) {
  const app = express()
  app.use('/api/tron', createChainTokenInspectionRouter({ tronWebFactory, now }))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const baseUrl = 'http://127.0.0.1:' + server.address().port
  try { await run(baseUrl) } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

function mockTronWeb({ failFirst = false } = {}) {
  const calls = []
  let failures = failFirst ? 1 : 0
  const token = {
    balanceOf: address => ({ call: async () => { calls.push(['balanceOf', address]); return '12345000' } }),
    decimals: () => ({ call: async () => { calls.push(['decimals']); return 6 } }),
    symbol: () => ({ call: async () => { calls.push(['symbol']); return 'USDT' } }),
    name: () => ({ call: async () => { calls.push(['name']); return 'Tether USD' } }),
    totalSupply: () => ({ call: async () => { calls.push(['totalSupply']); return '9999999990000000' } }),
  }
  const client = {
    isAddress: () => true,
    trx: {
      getContract: async address => {
        calls.push(['getContract', address])
        if (failures > 0) {
          failures -= 1
          throw Object.assign(new Error('Request failed with status code 429'), { status: 429 })
        }
        return { bytecode: '60806040' }
      },
    },
    contract: async (_abi, address) => { calls.push(['contract', address]); return token },
  }
  return { client, calls }
}

test('backend token inspection reads chain metadata and balance with sequential calls', async () => {
  const mock = mockTronWeb()
  await withServer({ tronWebFactory: async () => mock.client }, async base => {
    const response = await fetch(base + '/api/tron/inspect-token?network=mainnet&contract=' + contractAddress + '&owner=' + ownerAddress)
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.success, true)
    assert.equal(body.contractAddress, contractAddress)
    assert.equal(body.ownerAddress, ownerAddress)
    assert.equal(body.balanceBaseUnits, '12345000')
    assert.equal(body.tokenDecimals, 6)
    assert.equal(body.tokenSymbol, 'USDT')
    assert.equal(body.onChainContractDeployed, true)
    assert.equal(body.cache, 'miss')
    assert.deepEqual(mock.calls.map(call => call[0]), ['getContract', 'contract', 'balanceOf', 'decimals', 'symbol', 'name', 'totalSupply'])
  })
})

test('backend token inspection retries a rate-limited provider and caches the successful result', async () => {
  const mock = mockTronWeb({ failFirst: true })
  let now = 1000
  await withServer({ tronWebFactory: async () => mock.client, now: () => now }, async base => {
    const url = base + '/api/tron/inspect-token?network=mainnet&contract=' + contractAddress + '&owner=' + ownerAddress
    const first = await fetch(url)
    const firstBody = await first.json()
    assert.equal(first.status, 200)
    assert.equal(firstBody.cache, 'miss')
    const callsAfterFirst = mock.calls.length
    const second = await fetch(url)
    const secondBody = await second.json()
    assert.equal(second.status, 200)
    assert.equal(secondBody.cache, 'hit')
    assert.equal(mock.calls.length, callsAfterFirst)
    now += 16_000
  })
})

test('backend token inspection rejects invalid network and malformed addresses before RPC calls', async () => {
  let calls = 0
  await withServer({ tronWebFactory: async () => { calls += 1; throw new Error('unexpected RPC') } }, async base => {
    const badNetwork = await fetch(base + '/api/tron/inspect-token?network=other&contract=' + contractAddress + '&owner=' + ownerAddress)
    const badOwner = await fetch(base + '/api/tron/inspect-token?network=mainnet&contract=' + contractAddress + '&owner=not-an-address')
    assert.equal(badNetwork.status, 400)
    assert.equal(badOwner.status, 400)
    assert.equal(calls, 0)
  })
})

test('backend token inspection returns a safe retryable status after persistent rate limiting', async () => {
  const client = {
    isAddress: () => true,
    trx: { getContract: async () => { throw Object.assign(new Error('429 too many requests'), { status: 429 }) } },
    contract: async () => { throw new Error('should not be reached') },
  }
  await withServer({ tronWebFactory: async () => client }, async base => {
    const response = await fetch(base + '/api/tron/inspect-token?network=mainnet&contract=' + contractAddress + '&owner=' + ownerAddress)
    const body = await response.json()
    assert.equal(response.status, 503)
    assert.equal(body.error, 'chain-provider-rate-limited')
    assert.equal(body.retryable, true)
    assert.doesNotMatch(JSON.stringify(body), /TRON-PRO-API-KEY|x-api-key|private key/i)
  })
})
