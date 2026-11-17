import test from 'node:test'
import assert from 'node:assert/strict'
import { createTenergyPublicChainReader } from '../server/providers/tenergy-public-chain.mjs'

const owner = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body } }
}

test('public TEnergy observer reads Mainnet resources without credentials and never advertises grant submission', async () => {
  const calls = []
  const reader = createTenergyPublicChainReader({
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      if (url.endsWith('/status')) return response({ network: 'mainnet', status: 'operational', as_of: '2026-11-17T00:00:00.000Z' })
      return response({
        address: owner,
        activated: true,
        energy: { available: 950000, delegated_in: 950000 },
        bandwidth: { available: 1100, delegated_in: 500, free_net_limit: 600 },
        as_of: '2026-11-17T00:00:00.000Z',
      })
    },
  })
  const [resources, health] = await Promise.all([reader.readResources(owner), reader.health()])
  assert.equal(resources.success, true)
  assert.equal(resources.resources.energyAvailable, '950000')
  assert.equal(resources.resources.bandwidthAvailableForOneTransaction, '1100')
  assert.equal(resources.capabilities.freeGrantRequest, false)
  assert.equal(resources.capabilities.providerManagedSigner, false)
  assert.equal(health.reachable, true)
  assert.equal(calls.length, 2)
  assert.ok(calls.every(({ options }) => options.method === 'GET' && !('authorization' in options.headers)))
})

test('public TEnergy observer rejects a mismatched owner response', async () => {
  const reader = createTenergyPublicChainReader({
    fetchImpl: async () => response({
      address: 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8',
      activated: true,
      energy: { available: 1, delegated_in: 0 },
      bandwidth: { available: 600, delegated_in: 0 },
      as_of: '2026-11-17T00:00:00.000Z',
    }),
  })
  const result = await reader.readResources(owner)
  assert.equal(result.success, false)
  assert.equal(result.status, 'public-resource-observation-unavailable')
})

test('public TEnergy observer treats malformed resource quantities as unavailable', async () => {
  const reader = createTenergyPublicChainReader({
    fetchImpl: async () => response({
      address: owner,
      activated: true,
      energy: { available: 'not-a-number', delegated_in: '0' },
      bandwidth: { available: 600, delegated_in: 0 },
      as_of: '2026-11-17T00:00:00.000Z',
    }),
  })
  const result = await reader.readResources(owner)
  assert.equal(result.success, false)
})
