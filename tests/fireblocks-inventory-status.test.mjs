import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { createFireblocksInventoryStatusRouter } from '../server/routes/fireblocks-inventory-status.mjs'

const OWNER = 'T' + 'A'.repeat(33)
const TOKEN = 'a'.repeat(43)
const ORIGIN = 'https://studio.example'
const ENV = {
  OWNER_WALLET_ADDRESS: OWNER,
  TREASURY_OWNER_ADDRESS: OWNER,
}

async function withServer(options, callback) {
  const app = express()
  app.use('/api/treasury', createFireblocksInventoryStatusRouter({
    env: ENV,
    isValidAddress: (value) => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value),
    ...options,
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  try {
    await callback('http://127.0.0.1:' + address.port + '/api/treasury/fireblocks/inventory/latest')
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

function authorizedSession(overrides = {}) {
  return async ({ tokenHash, origin }) => {
    assert.match(tokenHash, /^[0-9a-f]{64}$/)
    assert.equal(origin, ORIGIN)
    return {
      success: true,
      session: { address: OWNER, network: 'mainnet', origin: ORIGIN, ...overrides },
    }
  }
}

async function getStatus(url, { token = TOKEN, origin = ORIGIN } = {}) {
  const headers = {}
  if (token) headers.Authorization = 'Bearer ' + token
  if (origin) headers.Origin = origin
  return fetch(url, { headers })
}

test('Fireblocks inventory status requires an owner session before database access', async () => {
  let reads = 0
  await withServer({
    getSession: async () => { throw new Error('must not be called without token') },
    readLatestSnapshot: async () => { reads += 1; return { success: true, snapshot: null } },
  }, async (url) => {
    const response = await getStatus(url, { token: '' })
    const payload = await response.json()
    assert.equal(response.status, 401)
    assert.equal(payload.error, 'owner-session-required')
    assert.equal(reads, 0)
  })
})

test('Fireblocks inventory status rejects a session for another wallet', async () => {
  await withServer({
    getSession: authorizedSession({ address: 'T' + 'B'.repeat(33) }),
    readLatestSnapshot: async () => ({ success: true, snapshot: null }),
  }, async (url) => {
    const response = await getStatus(url)
    const payload = await response.json()
    assert.equal(response.status, 403)
    assert.equal(payload.error, 'owner-wallet-not-authorized')
  })
})

test('Fireblocks inventory status returns only sanitized owner-visible snapshot data', async () => {
  const snapshot = {
    id: '91',
    workflowRunId: '123456789',
    workflowRunAttempt: 2,
    repository: 'MyTeleProject2026/trc20-usdt-token-cloner',
    branch: 'main',
    commitSha: 'a'.repeat(40),
    verificationStatus: 'verified',
    checkedAt: '2026-11-01T00:00:00.000Z',
    configuration: {
      apiBase: 'https://api.fireblocks.io',
      vaultAccountId: '42',
      usdtAssetId: 'TRON_USDT',
      trxAssetId: 'TRX',
      treasuryAddress: OWNER,
      signerMode: 'fireblocks',
      network: 'mainnet',
      usdtContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      usdtDecimals: 6,
      trxDecimals: 6,
      apiKeyConfigured: true,
      rsaKeyConfigured: true,
      secretKeyPath: '/etc/secrets/private.pem',
      privateKey: 'must-not-leak',
    },
    checks: {
      fireblocksApiAuthenticated: true,
      officialUsdtAssetVerified: true,
      databaseReady: true,
      unrecognizedSecretField: 'must-not-leak',
    },
    balances: {
      fireblocksUsdtAvailableBaseUnits: '25000000',
      chainUsdtBalanceBaseUnits: '25000000',
      fireblocksTrxAvailableBaseUnits: '4000000',
      chainTrxBalanceSun: '4000000',
      apiToken: 'must-not-leak',
    },
    reasons: [],
  }
  await withServer({
    getSession: authorizedSession(),
    readLatestSnapshot: async () => ({ success: true, snapshot }),
  }, async (url) => {
    const response = await getStatus(url)
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.success, true)
    assert.equal(payload.snapshot.verificationStatus, 'verified')
    assert.equal(payload.snapshot.configuration.vaultAccountId, '42')
    assert.equal(payload.snapshot.balances.chainUsdtBalanceBaseUnits, '25000000')
    assert.equal(payload.snapshot.workflowRunUrl, 'https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/actions/runs/123456789')
    assert.equal(payload.payoutExecutionEnabled, false)
    const serialized = JSON.stringify(payload)
    assert.equal(serialized.includes('private.pem'), false)
    assert.equal(serialized.includes('must-not-leak'), false)
    assert.equal(serialized.includes('secretKeyPath'), false)
  })
})

test('no persisted inventory run is represented as null and never enables payouts', async () => {
  await withServer({
    getSession: authorizedSession(),
    readLatestSnapshot: async () => ({ success: true, snapshot: null }),
  }, async (url) => {
    const response = await getStatus(url)
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.snapshot, null)
    assert.equal(payload.payoutExecutionEnabled, false)
  })
})

test('Fireblocks inventory status fails closed when snapshot storage is unavailable', async () => {
  await withServer({
    getSession: authorizedSession(),
    readLatestSnapshot: async () => ({ success: false, reason: 'database-unavailable' }),
  }, async (url) => {
    const response = await getStatus(url)
    const payload = await response.json()
    assert.equal(response.status, 503)
    assert.equal(payload.error, 'fireblocks-inventory-status-unavailable')
  })
})

test('Fireblocks inventory status requires one unified configured owner identity', async () => {
  const app = express()
  app.use('/api/treasury', createFireblocksInventoryStatusRouter({
    env: { ...ENV, TREASURY_OWNER_ADDRESS: 'T' + 'B'.repeat(33) },
    getSession: authorizedSession(),
    readLatestSnapshot: async () => ({ success: true, snapshot: null }),
    isValidAddress: () => true,
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  try {
    const response = await getStatus('http://127.0.0.1:' + address.port + '/api/treasury/fireblocks/inventory/latest')
    const payload = await response.json()
    assert.equal(response.status, 503)
    assert.equal(payload.error, 'treasury-owner-configuration-invalid')
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
