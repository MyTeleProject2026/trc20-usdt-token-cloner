import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { createFireblocksDiscoveryRouter } from '../server/routes/fireblocks-discovery.mjs'

const OWNER = 'T' + 'A'.repeat(33)
const OTHER = 'T' + 'B'.repeat(33)
const TOKEN = 'a'.repeat(43)
const ORIGIN = 'https://studio.example'
const OFFICIAL_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const ENV = {
  OWNER_WALLET_ADDRESS: OWNER,
  TREASURY_OWNER_ADDRESS: OWNER,
  FIREBLOCKS_API_KEY: 'discovery-api-key-do-not-return',
  FIREBLOCKS_SECRET_KEY_PATH: '/run/secrets/fireblocks-api.pem',
  FIREBLOCKS_API_BASE: 'https://api.fireblocks.io',
}

function makeFixture({
  env = ENV,
  vaults = [{ id: '7', name: 'TRON treasury', assets: [{ id: 'USDT_TRON' }, { id: 'TRX' }] }],
  usdtAddress = OWNER,
  trxAddress = OWNER,
} = {}) {
  const calls = []
  const fireblocksFactory = () => ({
    async getPagedVaultAccounts(args) {
      calls.push(['vaults', args])
      return { accounts: vaults, paging: {} }
    },
    async getAssets({ symbol, pageSize, pageCursor }) {
      calls.push(['assets', { symbol, pageSize, pageCursor }])
      if (symbol === 'USDT') {
        return { assets: [{ id: 'USDT_TRON', symbol: 'USDT', contractAddress: OFFICIAL_USDT }] }
      }
      return { assets: [{ id: 'TRX', legacyId: 'TRX', symbol: 'TRX', assetClass: 'NATIVE', onchain: { symbol: 'TRX', decimals: 6 } }] }
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
    isValidAddress: (value) => value === OWNER || value === OTHER,
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
  const fixture = makeFixture({ env: { ...ENV, FIREBLOCKS_API_KEY: '', FIREBLOCKS_SECRET_KEY_PATH: '' } })
  await withServer(fixture, async (url) => {
    const response = await getDiscovery(url)
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.discoveryStatus, 'credentials-required')
    assert.deepEqual(payload.configuration.credentialsMissing, ['FIREBLOCKS_API_KEY', 'FIREBLOCKS_SECRET_KEY_PATH'])
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
