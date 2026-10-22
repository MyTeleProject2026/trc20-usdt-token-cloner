import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { buildGasFreeAuthHeaders, createGasFreeClient, getGasFreeNetwork } from '../server/gasfree-client.mjs'

const validAddress = 'T' + 'A'.repeat(33)
const mainnetEnv = { GASFREE_MAINNET_API_KEY: 'mainnet-key', GASFREE_MAINNET_API_SECRET: 'mainnet-secret' }
const nileEnv = { GASFREE_NILE_API_KEY: 'nile-key', GASFREE_NILE_API_SECRET: 'nile-secret' }

test('GasFree network map uses isolated mainnet and Nile API credentials and excludes Shasta', () => {
  assert.equal(getGasFreeNetwork('mainnet').origin, 'https://open.gasfree.io')
  assert.equal(getGasFreeNetwork('mainnet').apiKeyEnv, 'GASFREE_MAINNET_API_KEY')
  assert.equal(getGasFreeNetwork('nile').pathPrefix, '/nile')
  assert.equal(getGasFreeNetwork('nile').apiKeyEnv, 'GASFREE_NILE_API_KEY')
  assert.equal(getGasFreeNetwork('shasta'), null)
  assert.equal(getGasFreeNetwork('https://attacker.example'), null)
})

test('GasFree HMAC auth signs method + path + timestamp and exposes no secret field', () => {
  const headers = buildGasFreeAuthHeaders('GET', '/tron/api/v1/config/token/all', {
    apiKey: 'public-key',
    apiSecret: 'test-secret',
    timestamp: 1731912286,
  })
  const expected = createHmac('sha256', 'test-secret')
    .update('GET/tron/api/v1/config/token/all1731912286')
    .digest('base64')
  assert.equal(headers.Timestamp, '1731912286')
  assert.equal(headers.Authorization, `ApiKey public-key:${expected}`)
  assert.equal(Object.hasOwn(headers, 'apiSecret'), false)
  assert.throws(() => buildGasFreeAuthHeaders('GET', '//attacker.example', {
    apiKey: 'key', apiSecret: 'secret', timestamp: 1,
  }), /Invalid GasFree API authentication input/)
})

test('GasFree does not attempt a network call without credentials for the selected network', async () => {
  let calls = 0
  const client = createGasFreeClient({
    env: mainnetEnv,
    fetchImpl: async () => { calls += 1; throw new Error('must not call') },
    now: () => 100,
  })
  const result = await client.getCapabilities('nile')
  assert.equal(result.configured, false)
  assert.equal(result.reason, 'credentials-not-configured')
  assert.deepEqual(result.requiredEnvironment, ['GASFREE_NILE_API_KEY', 'GASFREE_NILE_API_SECRET'])
  assert.equal(client.isConfigured('mainnet'), true)
  assert.equal(client.isConfigured('nile'), false)
  assert.equal(calls, 0)
})

test('GasFree capabilities return live provider list and token-denominated fee fields', async () => {
  const requested = []
  const fetchImpl = async (url, options) => {
    requested.push({ url, options })
    if (url.endsWith('/tron/api/v1/config/provider/all')) {
      return { ok: true, status: 200, json: async () => ({
        code: 200,
        data: { providers: [{ address: validAddress, name: 'Provider A', website: 'https://provider.example', config: {
          maxPendingTransfer: 1, minDeadlineDuration: 60, maxDeadlineDuration: 600, defaultDeadlineDuration: 180,
        } }, { address: 'not-an-address', name: 'spoofed' }] },
      }) }
    }
    return { ok: true, status: 200, json: async () => ({
      code: 200,
      data: { tokens: [{
        tokenAddress: validAddress, symbol: 'USDT', decimal: 6, supported: true,
        activateFee: 1000000, transferFee: '2500000',
      }, {
        tokenAddress: 'bad', symbol: 'OTHER', decimal: 6, supported: true,
        activateFee: 1, transferFee: 2,
      }] },
    }) }
  }
  const client = createGasFreeClient({
    env: mainnetEnv,
    fetchImpl,
    now: () => 1731912286,
  })

  const result = await client.getCapabilities('mainnet')
  assert.equal(result.reachable, true)
  assert.equal(result.providerCount, 1)
  assert.equal(result.supportedTokenCount, 1)
  assert.deepEqual(result.tokens[0], {
    tokenAddress: validAddress,
    symbol: 'USDT',
    decimals: 6,
    supported: true,
    activationFeeBaseUnits: '1000000',
    transferFeeBaseUnits: '2500000',
    feeCurrency: 'transferred-token',
  })
  assert.equal(result.providerFundingVerified, false)
  assert.equal(result.canSubmitSponsoredTransfer, false)
  assert.equal(requested.length, 2)
  assert.ok(requested.every((item) => item.options.headers.Authorization.startsWith('ApiKey mainnet-key:')))
  assert.ok(requested.every((item) => !item.url.includes('mainnet-secret')))
  assert.ok(requested.every((item) => !JSON.stringify(item.options).includes('mainnet-secret')))
})

test('GasFree rejects malformed API payloads and sanitizes provider errors', async () => {
  const client = createGasFreeClient({
    env: nileEnv,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ code: 200, data: {} }) }),
    now: () => 1731912286,
  })
  const malformed = await client.getCapabilities('nile')
  assert.equal(malformed.reachable, false)
  assert.equal(malformed.reason, 'invalid-provider-response')

  const rejected = createGasFreeClient({
    env: nileEnv,
    fetchImpl: async () => ({ ok: false, status: 403 }),
    now: () => 1731912286,
  })
  const denied = await rejected.getCapabilities('nile')
  assert.equal(denied.reason, 'provider-auth-rejected')
  assert.equal(denied.providerStatus, 403)
  assert.equal(JSON.stringify(denied).includes('nile-secret'), false)
})
