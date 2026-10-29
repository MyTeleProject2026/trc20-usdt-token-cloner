import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, verify } from 'node:crypto'
import {
  classifyFireblocksTransaction,
  createFireblocksClient,
  createFireblocksJwt,
  extractFireblocksAddresses,
  fireblocksAssetIdentifierMatches,
  fireblocksConfiguration,
  isOfficialFireblocksUsdtAsset,
  providerAssetAvailableBaseUnits,
} from '../server/fireblocks-client.mjs'

const officialUsdt = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const knownHex = '41' + '33'.repeat(20)
const fakeTronWeb = {
  address: {
    toHex(value) {
      if (value === officialUsdt) return knownHex
      if (value === 'TWrongContractAddressThatIsNotOfficial111') return '41' + '44'.repeat(20)
      return ''
    },
  },
}

function keyPair() {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return {
    privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: pair.publicKey,
  }
}

const configuredEnv = {
  FIREBLOCKS_API_KEY: 'test-api-key',
  FIREBLOCKS_SECRET_KEY_PATH: '/run/secrets/fireblocks-api.pem',
  FIREBLOCKS_VAULT_ACCOUNT_ID: '0',
  FIREBLOCKS_USDT_ASSET_ID: 'USDT_TRON',
  FIREBLOCKS_API_BASE: 'https://api.fireblocks.io',
}

test('Fireblocks integration remains disabled when required provider configuration is missing', () => {
  const status = fireblocksConfiguration({})
  assert.equal(status.configured, false)
  assert.ok(status.missing.includes('FIREBLOCKS_API_KEY'))
  assert.ok(status.missing.includes('FIREBLOCKS_SECRET_KEY_PATH'))
  assert.ok(status.missing.includes('FIREBLOCKS_VAULT_ACCOUNT_ID'))
  assert.ok(status.missing.includes('FIREBLOCKS_USDT_ASSET_ID'))
})

test('native TRX asset metadata must match the configured Fireblocks ID, native asset class and TRX symbol', () => {
  assert.equal(isOfficialFireblocksNativeTrxAsset({
    id: 'TRX',
    legacyId: 'TRX',
    assetClass: 'NATIVE',
    onchain: { symbol: 'TRX', name: 'TRON' },
  }, 'TRX'), true)
  assert.equal(isOfficialFireblocksNativeTrxAsset({
    id: 'TRC20_WRONG',
    legacyId: 'TRX',
    assetClass: 'FT',
    onchain: { symbol: 'TRX' },
  }, 'TRX'), false)
  assert.equal(isOfficialFireblocksNativeTrxAsset({
    id: 'TRX',
    assetClass: 'NATIVE',
    onchain: { symbol: 'USDT' },
  }, 'TRX'), false)
  assert.equal(isOfficialFireblocksNativeTrxAsset({
    id: 'TRX',
    assetClass: 'NATIVE',
    onchain: { symbol: 'TRX' },
  }, ''), false)
})

test('Fireblocks accepts only an absolute mounted secret-file path and known production API origin', () => {
  assert.equal(fireblocksConfiguration(configuredEnv).configured, true)
  assert.equal(fireblocksConfiguration({
    ...configuredEnv, FIREBLOCKS_SECRET_KEY_PATH: 'secret.pem',
  }).configured, false)
  assert.equal(fireblocksConfiguration({
    ...configuredEnv, FIREBLOCKS_API_BASE: 'https://attacker.example',
  }).configured, false)
})

test('Fireblocks JWT signs URI, nonce, time, API key subject and exact body hash', () => {
  const { privateKey, publicKey } = keyPair()
  const body = JSON.stringify({ operation: 'TRANSFER', amount: '1.25' })
  const token = createFireblocksJwt({
    apiKey: 'api-subject',
    secretKey: privateKey,
    uri: '/v1/transactions',
    body,
    now: 1_700_000_000_000,
    nonce: 'one-time-nonce',
  })
  const [header64, payload64, signature64] = token.split('.')
  const header = JSON.parse(Buffer.from(header64, 'base64url').toString('utf8'))
  const payload = JSON.parse(Buffer.from(payload64, 'base64url').toString('utf8'))
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' })
  assert.equal(payload.uri, '/v1/transactions')
  assert.equal(payload.nonce, 'one-time-nonce')
  assert.equal(payload.sub, 'api-subject')
  assert.equal(payload.iat, 1_700_000_000)
  assert.equal(payload.exp, 1_700_000_020)
  assert.equal(payload.bodyHash, createHash('sha256').update(body).digest('hex'))
  assert.equal(verify('RSA-SHA256', Buffer.from(header64 + '.' + payload64), publicKey, Buffer.from(signature64, 'base64url')), true)
})

test('Fireblocks JWT rejects URL-based paths and malformed configuration', () => {
  const { privateKey } = keyPair()
  assert.throws(() => createFireblocksJwt({
    apiKey: 'k', secretKey: privateKey, uri: 'https://attacker.example/v1/transactions',
  }))
})

test('provider available USDT amount parses exactly and accepts zero without floating point', () => {
  assert.equal(providerAssetAvailableBaseUnits({ available: '1.234567' }), '1234567')
  assert.equal(providerAssetAvailableBaseUnits({ available: '0' }), '0')
  assert.equal(providerAssetAvailableBaseUnits({ available: '120' }), '120000000')
  assert.equal(providerAssetAvailableBaseUnits({ available: '1.000000' }), '1000000')
  for (const available of ['1.0000001', '1e3', '-1', '01', '', 'NaN', '9'.repeat(100)]) {
    assert.equal(providerAssetAvailableBaseUnits({ available }), null, String(available))
  }
  assert.equal(providerAssetAvailableBaseUnits({ total: '10' }), null)
})

test('Fireblocks vault addresses are extracted only from structured address fields', () => {
  assert.deepEqual(extractFireblocksAddresses({
    addresses: [{ address: 'TOne' }, { addressString: 'TTwo' }, { address_string: 'TThree' }, { nope: true }],
  }), ['TOne', 'TTwo', 'TThree'])
  assert.deepEqual(extractFireblocksAddresses({ addresses: [] }), [])
  assert.deepEqual(extractFireblocksAddresses(null), [])
})

test('managed asset identity must match a configured provider ID and the official TRON USDT contract', () => {
  assert.equal(fireblocksAssetIdentifierMatches({ id: 'USDT_TRON' }, 'USDT_TRON'), true)
  assert.equal(fireblocksAssetIdentifierMatches({ legacyId: 'USDT_TRON' }, 'USDT_TRON'), true)
  assert.equal(fireblocksAssetIdentifierMatches({ id: 'other', legacyId: 'USDT_TRON' }, 'USDT_TRON'), true)
  assert.equal(fireblocksAssetIdentifierMatches({ id: 'other' }, 'USDT_TRON'), false)
  assert.equal(isOfficialFireblocksUsdtAsset({
    id: 'USDT_TRON', contractAddress: officialUsdt,
  }, fakeTronWeb, officialUsdt), true)
  assert.equal(isOfficialFireblocksUsdtAsset({
    id: 'USDT_TRON', onchain: { address: officialUsdt },
  }, fakeTronWeb, officialUsdt), true)
  assert.equal(isOfficialFireblocksUsdtAsset({
    id: 'USDT_TRON', contractAddress: 'TWrongContractAddressThatIsNotOfficial111',
  }, fakeTronWeb, officialUsdt), false)
  assert.equal(isOfficialFireblocksUsdtAsset({
    id: 'USDT_TRON',
  }, fakeTronWeb, officialUsdt), false)
})

test('Fireblocks rejects conflicting populated contract metadata instead of accepting one matching alias', () => {
  assert.equal(isOfficialFireblocksUsdtAsset({
    id: 'USDT_TRON',
    contractAddress: officialUsdt,
    onchain: { address: 'TWrongContractAddressThatIsNotOfficial111' },
  }, fakeTronWeb, officialUsdt), false)

  assert.equal(isOfficialFireblocksUsdtAsset({
    id: 'USDT_TRON',
    contractAddress: officialUsdt,
    details: { contractAddress: 'TWrongContractAddressThatIsNotOfficial111' },
  }, fakeTronWeb, officialUsdt), false)

  assert.equal(isOfficialFireblocksUsdtAsset({
    id: 'USDT_TRON',
    contractAddress: officialUsdt,
    onchain: { address: officialUsdt },
  }, fakeTronWeb, officialUsdt), true)
})

test('provider status cannot be treated as chain confirmation without an actual transaction hash', () => {
  assert.deepEqual(classifyFireblocksTransaction({ id: 'provider-id-1', status: 'SUBMITTED' }), {
    providerStatus: 'SUBMITTED',
    transactionHash: null,
    localStatus: 'provider-pending',
    terminalFailure: false,
  })
  assert.deepEqual(classifyFireblocksTransaction({ id: 'provider-id-2', status: 'FAILED' }), {
    providerStatus: 'FAILED',
    transactionHash: null,
    localStatus: 'failed',
    terminalFailure: true,
  })
  assert.deepEqual(classifyFireblocksTransaction({
    id: 'provider-id-3', status: 'COMPLETED', txHash: 'a'.repeat(64),
  }), {
    providerStatus: 'COMPLETED',
    transactionHash: 'a'.repeat(64),
    localStatus: 'broadcast-accepted',
    terminalFailure: false,
  })
  assert.equal(classifyFireblocksTransaction({
    id: 'provider-id-4', status: 'COMPLETED', txHash: 'not-a-chain-hash',
  }).localStatus, 'provider-pending')
})

test('Fireblocks uses current asset metadata and paginates vault addresses', async () => {
  const { privateKey } = keyPair()
  const paths = []
  let addressPage = 0
  const client = createFireblocksClient(configuredEnv, {
    fetchImpl: async (url) => {
      paths.push(new URL(url).pathname + new URL(url).search)
      const pathname = new URL(url).pathname
      if (pathname === '/v1/assets/USDT_TRON') {
        return new Response(JSON.stringify({ id: 'TRON_USDT', legacyId: 'USDT_TRON', onchain: { address: officialUsdt } }), { status: 200 })
      }
      if (pathname.endsWith('/addresses_paginated')) {
        addressPage += 1
        const response = addressPage === 1
          ? { addresses: [{ address: 'T' + 'A'.repeat(33) }], paging: { after: 'cursor-2' } }
          : { addresses: [{ addressString: 'T' + 'B'.repeat(33) }], paging: {} }
        return new Response(JSON.stringify(response), { status: 200 })
      }
      throw new Error('unexpected URL')
    },
    readSecretFile: async () => privateKey,
    now: () => 1_700_000_000_000,
    nonceFactory: () => 'nonce-unique',
  })
  const metadata = await client.getAssetMetadata()
  assert.equal(metadata.legacyId, 'USDT_TRON')
  const addresses = await client.getAssetAddresses()
  assert.deepEqual(addresses.addresses, ['T' + 'A'.repeat(33), 'T' + 'B'.repeat(33)])
  assert.deepEqual(paths, [
    '/v1/assets/USDT_TRON',
    '/v1/vault/accounts/0/USDT_TRON/addresses_paginated?limit=500',
    '/v1/vault/accounts/0/USDT_TRON/addresses_paginated?limit=500&after=cursor-2',
  ])
})

test('Fireblocks transaction POST uses a provider vault source and never includes wallet key material', async () => {
  const { privateKey, publicKey } = keyPair()
  const calls = []
  const client = createFireblocksClient(configuredEnv, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({
        id: 'provider-request-123',
        status: 'SUBMITTED',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
    readSecretFile: async (path) => {
      assert.equal(path, configuredEnv.FIREBLOCKS_SECRET_KEY_PATH)
      return privateKey
    },
    now: () => 1_700_000_000_000,
    nonceFactory: () => 'nonce-unique',
  })
  const result = await client.createUsdtTransfer({
    recipientAddress: 'T' + 'A'.repeat(33),
    amountUsdt: '12.340005',
    externalTxId: 'treasury-payout-key-00001',
  })
  assert.equal(result.id, 'provider-request-123')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.fireblocks.io/v1/transactions')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.redirect, 'error')
  const sentBody = JSON.parse(calls[0].init.body)
  assert.deepEqual(sentBody.source, { type: 'VAULT_ACCOUNT', id: '0' })
  assert.deepEqual(sentBody.destination, {
    type: 'ONE_TIME_ADDRESS',
    oneTimeAddress: { address: 'T' + 'A'.repeat(33) },
  })
  assert.equal(sentBody.assetId, 'USDT_TRON')
  assert.equal(sentBody.amount, '12.340005')
  assert.equal(sentBody.externalTxId, 'treasury-payout-key-00001')
  assert.equal(JSON.stringify(sentBody).includes('privateKey'), false)
  const token = calls[0].init.headers.Authorization.slice('Bearer '.length)
  const [header64, payload64, signature64] = token.split('.')
  const payload = JSON.parse(Buffer.from(payload64, 'base64url').toString('utf8'))
  assert.equal(payload.bodyHash, createHash('sha256').update(calls[0].init.body).digest('hex'))
  assert.equal(verify('RSA-SHA256', Buffer.from(header64 + '.' + payload64), publicKey, Buffer.from(signature64, 'base64url')), true)
})
