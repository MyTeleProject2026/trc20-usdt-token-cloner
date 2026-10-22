import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { buildGasFreeAuthHeaders, createGasFreeClient, getGasFreeNetwork } from '../server/gasfree-client.mjs'
import { credentialGuard } from '../server/credential-guard.mjs'

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


test('GasFree account lookup is read-only, network-isolated, and marks provider data unfinalized', async () => {
  const requested = []
  const client = createGasFreeClient({
    env: nileEnv,
    fetchImpl: async (url, options) => {
      requested.push({ url, options })
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 200,
          data: {
            accountAddress: validAddress,
            gasFreeAddress: 'T' + 'B'.repeat(33),
            active: true,
            nonce: 7,
            allowSubmit: false,
            assets: [{
              tokenAddress: 'T' + 'C'.repeat(33),
              tokenSymbol: 'USDT',
              decimal: 6,
              activateFee: 10000000,
              transferFee: '5000000',
              frozen: '2500000',
            }],
          },
        }),
      }
    },
    now: () => 1731912286,
  })

  const result = await client.getAccount('nile', validAddress)
  assert.equal(result.reachable, true)
  assert.equal(result.accountLookupVerified, true)
  assert.equal(result.account.accountAddress, validAddress)
  assert.equal(result.account.nonce, 7)
  assert.equal(result.account.allowSubmit, false)
  assert.equal(result.account.chainFinalityVerified, false)
  assert.deepEqual(result.account.assets[0], {
    tokenAddress: 'T' + 'C'.repeat(33),
    tokenSymbol: 'USDT',
    decimals: 6,
    activationFeeBaseUnits: '10000000',
    transferFeeBaseUnits: '5000000',
    frozenBaseUnits: '2500000',
  })
  assert.equal(requested.length, 1)
  assert.ok(requested[0].url.startsWith('https://open-test.gasfree.io/nile/api/v1/address/'))
  assert.ok(requested[0].options.headers.Authorization.startsWith('ApiKey nile-key:'))
  assert.equal(JSON.stringify(result).includes('nile-secret'), false)
})

test('GasFree account lookup rejects malformed provider responses and invalid EOA addresses', async () => {
  let calls = 0
  const client = createGasFreeClient({
    env: mainnetEnv,
    fetchImpl: async () => {
      calls += 1
      return { ok: true, status: 200, json: async () => ({ code: 200, data: { active: true } }) }
    },
    now: () => 1731912286,
  })
  const invalid = await client.getAccount('mainnet', 'not-an-address')
  assert.equal(invalid.reason, 'invalid-account-address')
  assert.equal(calls, 0)
  const malformed = await client.getAccount('mainnet', validAddress)
  assert.equal(malformed.reachable, false)
  assert.equal(malformed.reason, 'invalid-provider-response')
  assert.equal(malformed.providerStatus, 502)
})

test('GasFree trace lookup sanitizes status and reports provider trace separately from chain finality', async () => {
  let requestedUrl = ''
  const client = createGasFreeClient({
    env: mainnetEnv,
    fetchImpl: async (url) => {
      requestedUrl = url
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 200,
          data: {
            id: 'abc_123-safe',
            state: 'SUCCEED',
            accountAddress: validAddress,
            gasFreeAddress: 'T' + 'B'.repeat(33),
            targetAddress: 'T' + 'C'.repeat(33),
            providerAddress: 'T' + 'D'.repeat(33),
            tokenAddress: 'T' + 'E'.repeat(33),
            amount: '5000000',
            maxFee: 1000000,
            transactionId: 'a'.repeat(64),
            createdAt: '2026-10-22T12:00:00Z',
          },
        }),
      }
    },
    now: () => 1731912286,
  })
  const result = await client.getTrace('mainnet', 'abc_123-safe')
  assert.equal(result.reachable, true)
  assert.equal(result.traceLookupVerified, true)
  assert.equal(result.trace.state, 'SUCCEED')
  assert.equal(result.trace.amountBaseUnits, '5000000')
  assert.equal(result.trace.maxFeeBaseUnits, '1000000')
  assert.equal(result.trace.transactionId, 'a'.repeat(64))
  assert.equal(result.trace.verifiedOnChain, false)
  assert.ok(requestedUrl.startsWith('https://open.gasfree.io/tron/api/v1/gasfree/abc_123-safe'))
})

test('GasFree trace lookup rejects unsafe IDs without calling provider', async () => {
  let calls = 0
  const client = createGasFreeClient({
    env: mainnetEnv,
    fetchImpl: async () => {
      calls += 1
      throw new Error('must not call provider')
    },
  })
  const result = await client.getTrace('mainnet', '../secret')
  assert.equal(result.reason, 'invalid-trace-id')
  assert.equal(calls, 0)
})


test('GasFree trace lookup refuses a provider response for a different trace ID', async () => {
  const client = createGasFreeClient({
    env: mainnetEnv,
    fetchImpl: async () => ({
      ok: true, status: 200,
      json: async () => ({ code: 200, data: { id: 'some-other-trace', state: 'SUCCEED' } }),
    }),
    now: () => 1731912286,
  })
  const result = await client.getTrace('mainnet', 'requested-trace')
  assert.equal(result.reachable, false)
  assert.equal(result.reason, 'invalid-provider-response')
})

test('HTTP response credential guard redacts Tatum, TRONGrid, and both GasFree network credentials', () => {
  const envKeys = [
    'TATUM_API_KEY',
    'TRONGRID_API_KEY',
    'GASFREE_MAINNET_API_KEY',
    'GASFREE_MAINNET_API_SECRET',
    'GASFREE_NILE_API_KEY',
    'GASFREE_NILE_API_SECRET',
  ]
  const before = new Map(envKeys.map((key) => [key, process.env[key]]))
  const secrets = envKeys.map((key, index) => {
    const value = `test-secret-${key.toLowerCase()}-value-${index}-not-for-production`
    process.env[key] = value
    return value
  })

  try {
    const sent = []
    const response = {
      json(payload) { sent.push(payload); return payload },
      send(payload) { sent.push(payload); return payload },
      type() { return this },
    }
    credentialGuard({}, response, () => {})
    response.json({ diagnosticEcho: secrets.join('|') })

    const serialized = sent.at(-1)
    assert.equal(typeof serialized, 'string')
    for (const secret of secrets) {
      assert.equal(serialized.includes(secret), false, `Response leaked ${secret.slice(0, 16)}`)
    }
    assert.equal(serialized.split('[REDACTED]').length - 1, secrets.length)
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

