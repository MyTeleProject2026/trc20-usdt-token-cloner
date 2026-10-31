import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { createFireblocksInventorySyncRouter, matchesFireblocksInventoryBearer } from '../server/routes/fireblocks-inventory-sync.mjs'

const secret = 'test-only-inventory-trigger-secret-0123456789'
const treasuryAddress = 'T' + 'A'.repeat(33)

function makeFixture({
  officialUsdtContract = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  persistResult = { persisted: true, duplicate: false, id: '51' },
  databaseUrl = 'postgresql://test.invalid/inventory',
} = {}) {
  const calls = { fireblocks: 0, persisted: null }
  const env = {
    FIREBLOCKS_SYNC_TRIGGER_TOKEN: secret,
    FIREBLOCKS_API_KEY: 'test-api-key-not-real',
    FIREBLOCKS_SECRET_KEY_PATH: '/tmp/fireblocks-api-test.pem',
    FIREBLOCKS_VAULT_ACCOUNT_ID: '42',
    FIREBLOCKS_USDT_ASSET_ID: 'USDT_ASSET',
    FIREBLOCKS_TRX_ASSET_ID: 'TRX_ASSET',
    FIREBLOCKS_API_BASE: 'https://api.fireblocks.io',
    TREASURY_ADDRESS: treasuryAddress,
    DATABASE_URL: databaseUrl,
  }
  const fireblocksFactory = () => ({
    async getVaultAccount() {
      calls.fireblocks += 1
      return { id: '42', assets: [{ id: 'USDT_ASSET' }, { id: 'TRX_ASSET' }] }
    },
    async getAssetMetadata(assetId) {
      if (assetId === 'USDT_ASSET') return { id: assetId, contractAddress: officialUsdtContract }
      return { id: assetId, assetClass: 'NATIVE', onchain: { symbol: 'TRX', decimals: 6 } }
    },
    async getVaultAccountAsset(assetId) {
      return { id: assetId, available: assetId === 'USDT_ASSET' ? '12.25' : '5.5' }
    },
    async getAssetAddresses() {
      return { addresses: [{ address: treasuryAddress }] }
    },
  })
  const tronFactory = () => ({
    isAddress: () => true,
    address: { toHex: (value) => value === 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' ? '41' + 'ab'.repeat(20) : '41' + 'cd'.repeat(20) },
    trx: { getBalance: async () => '5500000' },
    contract: async () => ({
      at: async () => ({
        symbol: () => ({ call: async () => 'USDT' }),
        decimals: () => ({ call: async () => 6 }),
        balanceOf: () => ({ call: async () => '12250000' }),
      }),
    }),
  })
  const saveSnapshot = async (input) => {
    calls.persisted = input
    return persistResult
  }
  const app = express()
  app.use(express.json({ limit: '32kb' }))
  app.use('/api/treasury', createFireblocksInventorySyncRouter({
    env, fireblocksFactory, tronFactory, saveSnapshot,
    now: () => new Date('2026-11-01T00:00:00.000Z'),
  }))
  const server = createServer(app)
  return { app, server, calls, env }
}

async function withServer(fixture, callback) {
  await new Promise((resolve) => fixture.server.listen(0, '127.0.0.1', resolve))
  try {
    const address = fixture.server.address()
    return await callback(`http://127.0.0.1:${address.port}/api/treasury/fireblocks/inventory-sync`)
  } finally {
    await new Promise((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()))
  }
}

const requestBody = {
  workflowRunId: '123456789',
  workflowRunAttempt: 1,
  repository: 'MyTeleProject2026/trc20-usdt-token-cloner',
  branch: 'main',
  commitSha: 'a'.repeat(40),
}

test('Fireblocks inventory trigger requires an exact long bearer secret', () => {
  assert.equal(matchesFireblocksInventoryBearer('Bearer ' + secret, secret), true)
  assert.equal(matchesFireblocksInventoryBearer('Bearer ' + secret, secret + 'x'), false)
  assert.equal(matchesFireblocksInventoryBearer('Bearer short', secret), false)
  assert.equal(matchesFireblocksInventoryBearer('Basic ' + secret, secret), false)
  assert.equal(matchesFireblocksInventoryBearer('Bearer ' + secret, ''), false)
})

test('read-only inventory sync verifies official USDT, native TRX, addresses and saves snapshot', async () => {
  const fixture = makeFixture()
  await withServer(fixture, async (url) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    })
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.verificationStatus, 'verified')
    assert.equal(payload.snapshotSaved, true)
    assert.equal(payload.snapshotId, '51')
    assert.equal(payload.checks.fireblocksApiAuthenticated, true)
    assert.equal(payload.checks.officialUsdtAssetVerified, true)
    assert.equal(payload.checks.nativeTrxAssetVerified, true)
    assert.equal(payload.checks.usdtAddressMatches, true)
    assert.equal(payload.checks.trxAddressMatches, true)
    assert.equal(payload.balances.fireblocksUsdtAvailableBaseUnits, '12250000')
    assert.equal(payload.balances.chainTrxBalanceSun, '5500000')
    assert.equal(fixture.calls.persisted.verificationStatus, 'verified')
    assert.equal(fixture.calls.persisted.repository, requestBody.repository)
    assert.equal(JSON.stringify(payload).includes(secret), false)
    assert.equal(JSON.stringify(fixture.calls.persisted).includes(envSecretMarker()), false)
  })
})

test('inventory endpoint rejects unauthorized callers before contacting Fireblocks', async () => {
  const fixture = makeFixture()
  await withServer(fixture, async (url) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer incorrect-secret-that-is-long-enough-123456', 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    })
    assert.equal(response.status, 401)
    assert.equal(fixture.calls.fireblocks, 0)
    assert.equal(fixture.calls.persisted, null)
  })
})

test('contradictory USDT contract metadata is blocked and recorded as a diagnostic', async () => {
  const fixture = makeFixture({ officialUsdtContract: 'T' + 'B'.repeat(33) })
  await withServer(fixture, async (url) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    })
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.verificationStatus, 'blocked')
    assert.equal(payload.checks.officialUsdtAssetVerified, false)
    assert.ok(payload.reasons.includes('fireblocks-asset-not-official-tron-usdt'))
    assert.equal(fixture.calls.persisted.verificationStatus, 'blocked')
  })
})

test('inventory result cannot be verified without database configuration', async () => {
  const fixture = makeFixture({ databaseUrl: '' })
  await withServer(fixture, async (url) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    })
    const payload = await response.json()
    assert.equal(payload.verificationStatus, 'blocked')
    assert.equal(payload.checks.databaseReady, false)
  })
})

function envSecretMarker() {
  return 'test-api-key-not-real'
}
