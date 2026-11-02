import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, verify } from 'node:crypto'
import {
  classifyFireblocksTransaction,
  createFireblocksClient,
  maxFireblocksEstimatedFeeSun,
  parseSixDecimalBaseUnits,
  createFireblocksJwt,
  extractFireblocksAddresses,
  fireblocksAssetIdentifierMatches,
  fireblocksConfiguration,
  isOfficialFireblocksUsdtAsset,
  isNativeFireblocksTrxAsset,
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

let cachedKeyPair
function keyPair() {
  // Fireblocks production API-user credentials use RSA-4096.
  if (!cachedKeyPair) {
    cachedKeyPair = generateKeyPairSync('rsa', { modulusLength: 4096 })
  }
  return {
    privateKey: cachedKeyPair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: cachedKeyPair.publicKey,
  }
}

const configuredEnv = {
  FIREBLOCKS_API_KEY: 'test-api-key',
  FIREBLOCKS_SECRET_KEY_PATH: '/run/secrets/fireblocks-api.pem',
  FIREBLOCKS_VAULT_ACCOUNT_ID: '0',
  FIREBLOCKS_USDT_ASSET_ID: 'USDT_TRON',
  FIREBLOCKS_TRX_ASSET_ID: 'TRX',
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

test('Fireblocks JWT rejects RSA keys weaker than the provider-required 4096-bit size', () => {
  const weak = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const weakPem = weak.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  assert.throws(
    () => createFireblocksJwt({
      apiKey: 'k',
      secretKey: weakPem,
      uri: '/v1/transactions',
      now: 1_700_000_000_000,
      nonce: 'weak-key-test',
    }),
    /RSA-4096/,
  )
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


test('native Fireblocks TRX asset metadata must identify the configured six-decimal native asset', () => {
  const nativeTrx = {
    id: 'TRX',
    legacyId: 'TRX',
    assetClass: 'NATIVE',
    onchain: { symbol: 'TRX', name: 'TRON', decimals: 6 },
  }
  assert.equal(isNativeFireblocksTrxAsset(nativeTrx, 'TRX'), true)
  assert.equal(isNativeFireblocksTrxAsset({ ...nativeTrx, assetClass: 'FT' }, 'TRX'), false)
  assert.equal(isNativeFireblocksTrxAsset({ ...nativeTrx, onchain: { symbol: 'USDT', decimals: 6 } }, 'TRX'), false)
  assert.equal(isNativeFireblocksTrxAsset({ ...nativeTrx, onchain: { symbol: 'TRX', decimals: 18 } }, 'TRX'), false)
  assert.equal(isNativeFireblocksTrxAsset({ ...nativeTrx, contractAddress: officialUsdt }, 'TRX'), false)
  assert.equal(isNativeFireblocksTrxAsset({ ...nativeTrx, id: 'OTHER', legacyId: 'OTHER' }, 'TRX'), false)
})

test('native TRX transfer uses its separate Fireblocks asset ID and works without a configured USDT asset ID', async () => {
  const { privateKey } = keyPair()
  const env = { ...configuredEnv, FIREBLOCKS_USDT_ASSET_ID: '' }
  const calls = []
  const client = createFireblocksClient(env, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ id: 'provider-trx-request-123', status: 'SUBMITTED' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    },
    readSecretFile: async () => privateKey,
    now: () => 1_700_000_000_000,
    nonceFactory: () => 'nonce-trx',
  })
  assert.equal(client.isConfigured(), false, 'USDT route should remain unconfigured')
  assert.equal(client.isTrxAssetConfigured(), true, 'native TRX route can use shared provider auth without USDT asset metadata')
  const result = await client.createTrxTransfer({
    recipientAddress: 'T' + 'A'.repeat(33),
    amountTrx: '12.340005',
    externalTxId: 'trx-payout-key-0000000001',
  })
  assert.equal(result.id, 'provider-trx-request-123')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.fireblocks.io/v1/transactions')
  const sent = JSON.parse(calls[0].init.body)
  assert.equal(sent.assetId, 'TRX')
  assert.equal(sent.amount, '12.340005')
  assert.deepEqual(sent.source, { type: 'VAULT_ACCOUNT', id: '0' })
  assert.deepEqual(sent.destination, {
    type: 'ONE_TIME_ADDRESS',
    oneTimeAddress: { address: 'T' + 'A'.repeat(33) },
  })
  assert.equal(sent.externalTxId, 'trx-payout-key-0000000001')
  assert.equal(Object.hasOwn(sent, 'privateKey'), false)
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


test('Fireblocks refuses zero-value USDT and TRX transfers at the provider boundary', async () => {
  const client = createFireblocksClient(configuredEnv, {
    fetchImpl: async () => {
      throw new Error('Provider request must not be attempted for an invalid amount')
    },
  })
  const recipientAddress = 'T' + 'A'.repeat(33)

  await assert.rejects(
    client.createUsdtTransfer({
      recipientAddress,
      amountUsdt: '0',
      externalTxId: 'zero-usdt-payout-test-0001',
    }),
    (error) => error?.code === 'invalid-fireblocks-transfer-request',
  )
  await assert.rejects(
    client.createUsdtTransfer({
      recipientAddress,
      amountUsdt: '0.000000',
      externalTxId: 'zero-usdt-payout-test-0002',
    }),
    (error) => error?.code === 'invalid-fireblocks-transfer-request',
  )
  await assert.rejects(
    client.createTrxTransfer({
      recipientAddress,
      amountTrx: '0.000000',
      externalTxId: 'zero-trx-payout-test-0001',
    }),
    (error) => error?.code === 'invalid-fireblocks-trx-transfer-request',
  )
  await assert.rejects(
    client.createTrxTransfer({
      recipientAddress,
      amountTrx: '0',
      externalTxId: 'zero-trx-payout-test-0002',
    }),
    (error) => error?.code === 'invalid-fireblocks-trx-transfer-request',
  )
})


test('Fireblocks fee estimate parser accepts only exact six-decimal strings and chooses the highest estimate', () => {
  assert.equal(parseSixDecimalBaseUnits('0'), '0')
  assert.equal(parseSixDecimalBaseUnits('1.234567'), '1234567')
  assert.equal(parseSixDecimalBaseUnits('2'), '2000000')
  for (const value of ['1.0000001', '1e3', '-1', '01', '', 1, '9'.repeat(100)]) {
    assert.equal(parseSixDecimalBaseUnits(value), null)
  }
  assert.equal(maxFireblocksEstimatedFeeSun({
    low: { networkFee: '0.10' },
    medium: { networkFee: '0.20' },
    high: { networkFee: '0.15' },
  }), '200000')
  assert.equal(maxFireblocksEstimatedFeeSun({
    low: { networkFee: '0.30' },
    medium: { networkFee: '0.20' },
    high: { networkFee: '0.40' },
  }), '400000')
  assert.equal(maxFireblocksEstimatedFeeSun({
    low: { networkFee: '0.10' },
    medium: { networkFee: 'invalid' },
    high: { networkFee: '0.20' },
  }), null)
  assert.equal(maxFireblocksEstimatedFeeSun({
    low: { networkFee: '0.10' },
    medium: { networkFee: '0.20' },
  }), null)
})

test('Fireblocks fee estimation submits a read-only estimate request for the exact configured vault transfer', async () => {
  const { privateKey } = keyPair()
  const calls = []
  const client = createFireblocksClient(configuredEnv, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({
        low: { networkFee: '0.10' },
        medium: { networkFee: '0.20' },
        high: { networkFee: '0.30' },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
    readSecretFile: async () => privateKey,
    now: () => 1_700_000_000_000,
    nonceFactory: () => 'fee-estimate-nonce',
  })
  const recipientAddress = 'T' + 'A'.repeat(33)
  const usdtEstimate = await client.estimateUsdtTransferFee({
    recipientAddress,
    amountUsdt: '1.000001',
  })
  const trxEstimate = await client.estimateTrxTransferFee({
    recipientAddress,
    amountTrx: '2.5',
  })

  assert.equal(usdtEstimate.high.networkFee, '0.30')
  assert.equal(trxEstimate.high.networkFee, '0.30')
  assert.equal(calls.length, 2)
  assert.ok(calls.every((call) => call.init.method === 'POST'))
  assert.ok(calls.every((call) => call.url === 'https://api.fireblocks.io/v1/transactions/estimate_fee'))
  const usdtBody = JSON.parse(calls[0].init.body)
  assert.equal(usdtBody.assetId, 'USDT_TRON')
  assert.equal(usdtBody.amount, '1.000001')
  assert.deepEqual(usdtBody.source, { type: 'VAULT_ACCOUNT', id: '0' })
  assert.deepEqual(usdtBody.destination, {
    type: 'ONE_TIME_ADDRESS',
    oneTimeAddress: { address: recipientAddress },
  })
  const trxBody = JSON.parse(calls[1].init.body)
  assert.equal(trxBody.assetId, 'TRX')
  assert.equal(trxBody.amount, '2.5')
  assert.equal('externalTxId' in usdtBody, false)
  assert.equal('privateKey' in usdtBody, false)
})


test('Fireblocks retrieves one existing vault account using the configured numeric account ID', async () => {
  const { privateKey } = keyPair()
  const calls = []
  const client = createFireblocksClient(configuredEnv, {
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({
        id: '0',
        name: 'Production TRON Treasury',
        assets: [{ id: 'TRON_USDT', available: '25.000000' }, { id: 'TRX', available: '90' }],
        hiddenOnUI: false,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
    readSecretFile: async () => privateKey,
    now: () => 1_700_000_000_000,
    nonceFactory: () => 'vault-account-read-test',
  })

  const account = await client.getVaultAccount()
  assert.equal(account.id, '0')
  assert.equal(account.name, 'Production TRON Treasury')
  assert.deepEqual(account.assets.map((asset) => asset.id), ['TRON_USDT', 'TRX'])
  assert.equal(calls.length, 1)
  assert.equal(new URL(calls[0].url).pathname, '/v1/vault/accounts/0')
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].init.body, undefined)
})

test('Fireblocks retrieves paged vault accounts with validated supported filters', async () => {
  const { privateKey } = keyPair()
  const calls = []
  const client = createFireblocksClient(configuredEnv, {
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({
        accounts: [{
          id: '0',
          name: 'Production TRON Treasury',
          assets: [{ id: 'TRON_USDT', total: '25', available: '25' }],
          tags: [{ id: 'df4c0987-30da-4976-8dcf-bc2dd41ae331', label: 'Treasury' }],
        }],
        paging: { before: '', after: 'next-page-cursor' },
        previousUrl: '',
        nextUrl: '/v1/vault/accounts_paged?after=next-page-cursor',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
    readSecretFile: async () => privateKey,
    now: () => 1_700_000_000_000,
    nonceFactory: () => 'vault-account-page-test',
  })

  const page = await client.getPagedVaultAccounts({
    limit: 300,
    assetId: 'TRON_USDT',
    orderBy: 'ASC',
    after: 'cursor-next',
    namePrefix: 'Production',
    nameSuffix: 'Treasury',
    minAmountThreshold: 0.5,
  })
  assert.equal(page.accounts[0].id, '0')
  assert.equal(page.accounts[0].assets[0].id, 'TRON_USDT')
  assert.equal(page.paging.after, 'next-page-cursor')
  assert.equal(calls.length, 1)
  const url = new URL(calls[0].url)
  assert.equal(url.pathname, '/v1/vault/accounts_paged')
  assert.deepEqual(Object.fromEntries(url.searchParams.entries()), {
    limit: '300',
    orderBy: 'ASC',
    assetId: 'TRON_USDT',
    after: 'cursor-next',
    namePrefix: 'Production',
    nameSuffix: 'Treasury',
    minAmountThreshold: '0.5',
  })
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].init.body, undefined)

  await assert.rejects(
    client.getPagedVaultAccounts({ before: 'old-cursor', after: 'new-cursor' }),
    (error) => error?.code === 'invalid-fireblocks-vault-account-page-request',
  )
  await assert.rejects(
    client.getPagedVaultAccounts({ limit: 501 }),
    (error) => error?.code === 'invalid-fireblocks-vault-account-page-request',
  )
  await assert.rejects(
    client.getPagedVaultAccounts({ minAmountThreshold: Number.NaN }),
    (error) => error?.code === 'invalid-fireblocks-vault-account-page-request',
  )
  assert.equal(calls.length, 1, 'invalid page filters must be rejected before any provider request')
})


test('Fireblocks outbound history uses explicit date bounds, vault source filters, and response-header pagination', async () => {
  const { privateKey } = keyPair()
  const calls = []
  const client = createFireblocksClient(configuredEnv, {
    fetchImpl: async (url) => {
      calls.push(new URL(url))
      const first = calls.length === 1
      return new Response(JSON.stringify(first
        ? [{ id: 'provider-outbound-1', operation: 'TRANSFER' }]
        : [{ id: 'provider-outbound-2', operation: 'TRANSFER' }]), {
        status: 200,
        headers: first ? { 'next-page': 'cursor-next-2' } : {},
      })
    },
    readSecretFile: async () => privateKey,
    now: () => 1_700_000_000_000,
    nonceFactory: () => 'nonce-history',
  })
  const first = await client.getTransactionsPage({ after: '1', before: '1800000000000', limit: 500 })
  assert.equal(first.transactions[0].id, 'provider-outbound-1')
  assert.equal(first.nextPage, 'cursor-next-2')
  const second = await client.getTransactionsPage({
    after: '1', before: '1800000000000', next: first.nextPage, limit: 500,
  })
  assert.equal(second.transactions[0].id, 'provider-outbound-2')
  assert.equal(second.nextPage, null)
  assert.deepEqual(calls.map((url) => ({
    pathname: url.pathname,
    after: url.searchParams.get('after'),
    before: url.searchParams.get('before'),
    limit: url.searchParams.get('limit'),
    sourceType: url.searchParams.get('sourceType'),
    sourceId: url.searchParams.get('sourceId'),
    orderBy: url.searchParams.get('orderBy'),
    sort: url.searchParams.get('sort'),
    next: url.searchParams.get('next'),
  })), [
    {
      pathname: '/v1/transactions', after: '1', before: '1800000000000',
      limit: '500', sourceType: 'VAULT_ACCOUNT', sourceId: '0', orderBy: 'createdAt', sort: 'ASC', next: null,
    },
    {
      pathname: '/v1/transactions', after: '1', before: '1800000000000',
      limit: '500', sourceType: 'VAULT_ACCOUNT', sourceId: '0', orderBy: 'createdAt', sort: 'ASC', next: 'cursor-next-2',
    },
  ])
})

test('Fireblocks outbound history rejects implicit date windows, invalid bounds and oversized cursors', async () => {
  const { privateKey } = keyPair()
  let calls = 0
  const client = createFireblocksClient(configuredEnv, {
    fetchImpl: async () => { calls += 1; return new Response('[]', { status: 200 }) },
    readSecretFile: async () => privateKey,
    now: () => 1_700_000_000_000,
    nonceFactory: () => 'nonce-history-invalid',
  })
  await assert.rejects(() => client.getTransactionsPage({ before: '1800000000000' }), /invalid-fireblocks-transaction-history-page-request/)
  await assert.rejects(() => client.getTransactionsPage({ after: '1800000000000', before: '1' }), /invalid-fireblocks-transaction-history-page-request/)
  await assert.rejects(() => client.getTransactionsPage({
    after: '1', before: '1800000000000', next: 'x'.repeat(8193),
  }), /invalid-fireblocks-transaction-history-page-request/)
  assert.equal(calls, 0)
})
