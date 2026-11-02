import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { createFireblocksDiscoveryRouter } from '../server/routes/fireblocks-discovery.mjs'

const OWNER = 'T' + 'A'.repeat(33)
const OTHER = 'T' + 'B'.repeat(33)
const BAD_CHECKSUM = 'T' + 'C'.repeat(33)
const TOKEN = 'a'.repeat(43)
const ORIGIN = 'https://studio.example'
const OFFICIAL_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const ENV = {
  OWNER_WALLET_ADDRESS: OWNER,
  TREASURY_OWNER_ADDRESS: OWNER,
  FIREBLOCKS_READONLY_API_KEY: 'discovery-api-key-do-not-return',
  FIREBLOCKS_READONLY_SECRET_KEY_PATH: '/run/secrets/fireblocks-readonly-api.pem',
  FIREBLOCKS_READONLY_API_BASE: 'https://api.fireblocks.io',
  FIREBLOCKS_API_KEY: 'payout-api-key-separate',
  FIREBLOCKS_SECRET_KEY_PATH: '/run/secrets/fireblocks-payout-api.pem',
  FIREBLOCKS_API_BASE: 'https://api.fireblocks.io',
}

function makeFixture({
  env = ENV,
  vaults = [{ id: '7', name: 'TRON treasury', assets: [{ id: 'USDT_TRON' }, { id: 'TRX' }] }],
  usdtAddress = OWNER,
  trxAddress = OWNER,
  nestedPagination = false,
  allowPatternOnlyAddress = false,
  uuidOnlyCatalog = false,
} = {}) {
  const calls = []
  const fireblocksFactory = () => ({
    async getPagedVaultAccounts(args) {
      calls.push(['vaults', args])
      if (nestedPagination) {
        return args.after
          ? { data: { accounts: [], paging: {} } }
          : { data: { accounts: vaults, paging: { after: 'vault-page-2' } } }
      }
      return { accounts: vaults, paging: {} }
    },
    async getAssets({ symbol, pageSize, pageCursor }) {
      calls.push(['assets', { symbol, pageSize, pageCursor }])
      if (symbol === 'USDT') {
        if (uuidOnlyCatalog) {
          return { assets: [{ id: '3ed32525-70df-45c8-bae3-e69ab56dc095', symbol: 'USDT', contractAddress: OFFICIAL_USDT }] }
        }
        if (nestedPagination && !pageCursor) {
          return { data: { assets: [{ id: 'USDT_WRONG', symbol: 'USDT', contractAddress: OTHER }], paging: { pageCursor: 'usdt-page-2' } } }
        }
        return nestedPagination
          ? { data: { assets: [{ id: '3ed32525-70df-45c8-bae3-e69ab56dc095', legacyId: 'USDT_TRON', symbol: 'USDT', contractAddress: OFFICIAL_USDT }], paging: {} } }
          : { assets: [{ id: '3ed32525-70df-45c8-bae3-e69ab56dc095', legacyId: 'USDT_TRON', symbol: 'USDT', contractAddress: OFFICIAL_USDT }] }
      }
      if (uuidOnlyCatalog) {
        return { assets: [{ id: '3a3b5f06-70df-45c8-bae3-e69ab56dc095', symbol: 'TRX', assetClass: 'NATIVE', onchain: { symbol: 'TRX', decimals: 6 } }] }
      }
      return nestedPagination
        ? { data: [{ id: '3a3b5f06-61e7-44f0-9962-4425b55795ff', legacyId: 'TRX', symbol: 'TRX', assetClass: 'NATIVE', onchain: { symbol: 'TRX', decimals: 6 } }], paging: {} }
        : { assets: [{ id: 'TRX', legacyId: 'TRX', symbol: 'TRX', assetClass: 'NATIVE', onchain: { symbol: 'TRX', decimals: 6 } }] }
    },
    async getAssetAddresses(assetId, vaultId, options) {
      calls.push(['addresses', { assetId, vaultId, options }])
      return { addresses: [{ address: assetId === 'USDT_TRON' ? usdtAddress : trxAddress }] }
    },
  })
  const app = express()
  app.use('/api/treasury', createFireblocksDiscoveryRouter({
    env,
    fireblocksFactory,
    getSession: async ({ tokenHash, origin }) => {
      assert.match(tokenHash, /^[0-9a-f]{64}$/)
      assert.equal(origin, ORIGIN)
      return { success: true, session: { address: OWNER, network: 'mainnet', origin } }
    },
    isValidAddress: (value) => value === OWNER || value === OTHER
      || (allowPatternOnlyAddress && value === BAD_CHECKSUM),
    tronWebFactory: () => ({
      isAddress: (value) => value === OWNER || value === OTHER,
      address: { toHex: (value) => value === OFFICIAL_USDT ? '41' + '11'.repeat(20) : '' },
    }),
    now: () => Date.parse('2026-11-02T12:00:00.000Z'),
  }))
  const server = createServer(app)
  return { server, calls }
}

async function withServer(fixture, callback) {
  await new Promise((resolve) => fixture.server.listen(0, '127.0.0.1', resolve))
  const address = fixture.server.address()
  try {
    await callback('http://127.0.0.1:' + address.port + '/api/treasury/fireblocks/discovery')
  } finally {
    await new Promise((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()))
  }
}

async function getDiscovery(url, { token = TOKEN, origin = ORIGIN } = {}) {
  const headers = {}
  if (token) headers.Authorization = 'Bearer ' + token
  if (origin) headers.Origin = origin
  return fetch(url, { headers })
}

test('Fireblocks discovery requires the authenticated owner before calling provider APIs', async () => {
  const fixture = makeFixture()
  await withServer(fixture, async (url) => {
    const response = await getDiscovery(url, { token: '' })
    const payload = await response.json()
    assert.equal(response.status, 401)
    assert.equal(payload.error, 'owner-session-required')
    assert.equal(fixture.calls.length, 0)
  })
})

test('Fireblocks discovery reports credential prerequisites without leaking secrets or calling the provider', async () => {
  const fixture = makeFixture({ env: { ...ENV, FIREBLOCKS_READONLY_API_KEY: '', FIREBLOCKS_READONLY_SECRET_KEY_PATH: '' } })
  await withServer(fixture, async (url) => {
    const response = await getDiscovery(url)
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.discoveryStatus, 'credentials-required')
    assert.deepEqual(payload.configuration.credentialsMissing, ['FIREBLOCKS_READONLY_API_KEY', 'FIREBLOCKS_READONLY_SECRET_KEY_PATH'])
    assert.equal(payload.suggestedConfiguration, null)
    assert.equal(JSON.stringify(payload).includes('discovery-api-key-do-not-return'), false)
    assert.equal(fixture.calls.length, 0)
  })
})

test('Fireblocks discovery finds an unambiguous official-asset vault and derives its shared TRON address without enabling payouts', async () => {
  const fixture = makeFixture()
  await withServer(fixture, async (url) => {
    const response = await getDiscovery(url)
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.discoveryStatus, 'single-unambiguous-candidate')
    assert.deepEqual(payload.suggestedConfiguration, {
      vaultAccountId: '7',
      usdtAssetId: 'USDT_TRON',
      trxAssetId: 'TRX',
      treasuryAddress: OWNER,
    })
    assert.equal(payload.candidateVaults[0].unambiguousAddressPair, true)
    assert.equal(payload.candidateVaults[0].addressChecks[0].providerAddressVerified, true)
    assert.equal(payload.configuration.vaultAccountIdConfigured, false)
    assert.equal(payload.configuration.usdtAssetIdConfigured, false)
    assert.equal(payload.note.includes('not an approved treasury configuration'), true)
    assert.equal(fixture.calls.some(([name]) => name === 'addresses'), true)
    assert.ok(fixture.calls.every(([, args]) => !args?.privateKey))
  })
})

test('Fireblocks discovery refuses to suggest a treasury when USDT and TRX addresses differ', async () => {
  const fixture = makeFixture({ trxAddress: OTHER })
  await withServer(fixture, async (url) => {
    const response = await getDiscovery(url)
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.discoveryStatus, 'review-required')
    assert.equal(payload.suggestedConfiguration, null)
    assert.equal(payload.candidateVaults[0].addressChecks[0].providerAddressVerified, false)
  })
})

test('Fireblocks discovery refuses automatic selection when more than one eligible vault exists', async () => {
  const fixture = makeFixture({
    vaults: [
      { id: '7', name: 'Treasury A', assets: [{ id: 'USDT_TRON' }, { id: 'TRX' }] },
      { id: '8', name: 'Treasury B', assets: [{ id: 'USDT_TRON' }, { id: 'TRX' }] },
    ],
  })
  await withServer(fixture, async (url) => {
    const response = await getDiscovery(url)
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.discoveryStatus, 'review-required')
    assert.equal(payload.suggestedConfiguration, null)
    assert.equal(payload.candidateVaults.length, 2)
  })
})


test('Fireblocks discovery caches the read-only workspace result across automatic dashboard refreshes', async () => {
  const fixture = makeFixture()
  await withServer(fixture, async (url) => {
    const first = await getDiscovery(url)
    const firstPayload = await first.json()
    const callsAfterFirst = fixture.calls.length
    const second = await getDiscovery(url)
    const secondPayload = await second.json()
    assert.equal(firstPayload.cacheHit, false)
    assert.equal(secondPayload.cacheHit, true)
    assert.equal(secondPayload.discoveryStatus, firstPayload.discoveryStatus)
    assert.equal(fixture.calls.length, callsAfterFirst, 'a fresh cached result must not repeat Fireblocks provider requests')
  })
})


test('Fireblocks discovery follows nested Fireblocks paging envelopes and keeps scanning until the official asset page', async () => {
  const fixture = makeFixture({ nestedPagination: true })
  await withServer(fixture, async (url) => {
    const response = await getDiscovery(url)
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.discoveryStatus, 'single-unambiguous-candidate')
    assert.deepEqual(payload.suggestedConfiguration, {
      vaultAccountId: '7',
      usdtAssetId: 'USDT_TRON',
      trxAssetId: 'TRX',
      treasuryAddress: OWNER,
    })
    assert.ok(fixture.calls.some(([name, args]) => name === 'vaults' && args.after === 'vault-page-2'))
    assert.ok(fixture.calls.some(([name, args]) => name === 'assets' && args.symbol === 'USDT' && args.pageCursor === 'usdt-page-2'))
    assert.equal(payload.discoveryTruncated, false)
  })
})


test('Fireblocks discovery prefers API-compatible legacy asset IDs when the catalogue also includes UUIDs', async () => {
  const fixture = makeFixture()
  await withServer(fixture, async (url) => {
    const response = await getDiscovery(url)
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.suggestedConfiguration.usdtAssetId, 'USDT_TRON')
    assert.equal(payload.suggestedConfiguration.trxAssetId, 'TRX')
  })
})


test('Fireblocks discovery rejects Base58-shaped addresses that fail TRON checksum validation', async () => {
  const fixture = makeFixture({
    usdtAddress: BAD_CHECKSUM,
    trxAddress: BAD_CHECKSUM,
    allowPatternOnlyAddress: true,
  })
  await withServer(fixture, async (url) => {
    const response = await getDiscovery(url)
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.discoveryStatus, 'review-required')
    assert.equal(payload.suggestedConfiguration, null)
    assert.equal(payload.candidateVaults[0].addressChecks[0].usdtAddressCount, 0)
    assert.equal(payload.candidateVaults[0].addressChecks[0].trxAddressCount, 0)
  })
})


test('Fireblocks discovery does not suggest UUID-only assets as payout API identifiers', async () => {
  const fixture = makeFixture({ uuidOnlyCatalog: true })
  await withServer(fixture, async (url) => {
    const response = await getDiscovery(url)
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.discoveryStatus, 'review-required')
    assert.equal(payload.officialUsdtAssets.length, 0)
    // Both catalogue entries are UUID-only, so neither is safe as a payout API ID.
    assert.equal(payload.nativeTrxAssets.length, 0)
    assert.equal(payload.suggestedConfiguration, null)
  })
})
