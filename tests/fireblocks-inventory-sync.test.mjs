import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import express from 'express'
import { createServer } from 'node:http'
import {
  createFireblocksInventorySyncRouter,
  verifyGitHubActionsInventoryOidcToken,
} from '../server/routes/fireblocks-inventory-sync.mjs'

const OIDC_ISSUER = 'https://token.actions.githubusercontent.com'
const OIDC_DISCOVERY = OIDC_ISSUER + '/.well-known/openid-configuration'
const OIDC_JWKS = OIDC_ISSUER + '/.well-known/jwks'
const OIDC_AUDIENCE = 'tron-token-studio-fireblocks-inventory'
const REPOSITORY = 'MyTeleProject2026/trc20-usdt-token-cloner'
const WORKFLOW = 'Fireblocks read-only inventory sync and config export'
const TREASURY_ADDRESS = 'T' + 'A'.repeat(33)
const NOW = new Date('2026-11-01T00:00:00.000Z')
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000)
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: 'inventory-test-signing-key', use: 'sig', alg: 'RS256' }

const requestBody = {
  workflowRunId: '123456789',
  workflowRunAttempt: 1,
  repository: REPOSITORY,
  branch: 'main',
  commitSha: 'a'.repeat(40),
}

function oidcClaims(overrides = {}) {
  return {
    iss: OIDC_ISSUER,
    aud: OIDC_AUDIENCE,
    sub: 'repo:MyTeleProject2026@267598483/trc20-usdt-token-cloner@1424901043:environment:fireblocks-readonly-sync',
    repository: REPOSITORY,
    repository_id: '1424901043',
    repository_owner: 'MyTeleProject2026',
    repository_owner_id: '267598483',
    ref: 'refs/heads/main',
    environment: 'fireblocks-readonly-sync',
    event_name: 'workflow_dispatch',
    workflow_ref: REPOSITORY + '/.github/workflows/fireblocks-inventory-sync.yml@refs/heads/main',
    workflow: WORKFLOW,
    run_id: requestBody.workflowRunId,
    run_attempt: String(requestBody.workflowRunAttempt),
    sha: requestBody.commitSha,
    jti: 'unit-test-unique-token-id-12345',
    iat: NOW_SECONDS - 30,
    nbf: NOW_SECONDS - 30,
    exp: NOW_SECONDS + 270,
    ...overrides,
  }
}

function createOidcToken(overrides = {}, { corruptSignature = false } = {}) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const unsigned = encode({ alg: 'RS256', typ: 'JWT', kid: publicJwk.kid })
    + '.' + encode(oidcClaims(overrides))
  const signature = sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')
  if (!corruptSignature) return unsigned + '.' + signature
  return unsigned + '.' + Buffer.from('invalid-signature').toString('base64url')
}

async function oidcFetch(url) {
  if (String(url) === OIDC_DISCOVERY) {
    return { ok: true, json: async () => ({ issuer: OIDC_ISSUER, jwks_uri: OIDC_JWKS }) }
  }
  if (String(url) === OIDC_JWKS) {
    return { ok: true, json: async () => ({ keys: [publicJwk] }) }
  }
  return { ok: false, json: async () => ({}) }
}

function makeFixture({
  officialUsdtContract = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  persistResult = { persisted: true, duplicate: false, id: '51' },
  databaseUrl = 'postgresql://test.invalid/inventory',
} = {}) {
  const calls = { fireblocks: 0, persisted: null }
  const env = {
    FIREBLOCKS_API_KEY: 'test-api-key-not-real',
    FIREBLOCKS_SECRET_KEY_PATH: '/tmp/fireblocks-api-test.pem',
    FIREBLOCKS_VAULT_ACCOUNT_ID: '42',
    FIREBLOCKS_USDT_ASSET_ID: 'USDT_ASSET',
    FIREBLOCKS_TRX_ASSET_ID: 'TRX_ASSET',
    FIREBLOCKS_API_BASE: 'https://api.fireblocks.io',
    TREASURY_ADDRESS: TREASURY_ADDRESS,
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
      return { addresses: [{ address: TREASURY_ADDRESS }] }
    },
  })
  const tronFactory = () => ({
    isAddress: () => true,
    address: {
      toHex: (value) => value === 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
        ? '41' + 'ab'.repeat(20) : '41' + 'cd'.repeat(20),
    },
    trx: { getBalance: async () => '5500000' },
    contract: () => ({
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
    env, fireblocksFactory, tronFactory, fetchImpl: oidcFetch, saveSnapshot,
    now: () => NOW,
  }))
  const server = createServer(app)
  return { app, server, calls, env }
}

async function withServer(fixture, callback) {
  await new Promise((resolve) => fixture.server.listen(0, '127.0.0.1', resolve))
  try {
    const address = fixture.server.address()
    return await callback('http://127.0.0.1:' + address.port + '/api/treasury/fireblocks/inventory-sync')
  } finally {
    await new Promise((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()))
  }
}

async function postInventory(url, token = createOidcToken(), body = requestBody) {
  return fetch(url, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('GitHub OIDC verification accepts only the signed, exact manual workflow identity', async () => {
  const result = await verifyGitHubActionsInventoryOidcToken(createOidcToken(), {
    workflowRunId: requestBody.workflowRunId,
    workflowRunAttempt: requestBody.workflowRunAttempt,
    commitSha: requestBody.commitSha,
  }, { fetchImpl: oidcFetch, now: () => NOW.getTime() })
  assert.deepEqual(result, { verified: true })
})

test('GitHub OIDC verification rejects wrong issuer, audience, environment, event and workflow claims', async () => {
  const invalidClaims = [
    { iss: 'https://attacker.invalid' },
    { aud: 'another-api' },
    { environment: 'production' },
    { event_name: 'push' },
    { workflow_ref: 'attacker/repo/.github/workflows/other.yml@refs/heads/main' },
    { repository_id: '1' },
    { run_id: '987654321' },
    { sha: 'b'.repeat(40) },
    { exp: NOW_SECONDS - 1 },
  ]
  for (const override of invalidClaims) {
    const result = await verifyGitHubActionsInventoryOidcToken(createOidcToken(override), {
      workflowRunId: requestBody.workflowRunId,
      workflowRunAttempt: requestBody.workflowRunAttempt,
      commitSha: requestBody.commitSha,
    }, { fetchImpl: oidcFetch, now: () => NOW.getTime() })
    assert.equal(result.verified, false, JSON.stringify(override))
  }
})

test('GitHub OIDC verification rejects a modified JWT signature', async () => {
  const result = await verifyGitHubActionsInventoryOidcToken(
    createOidcToken({}, { corruptSignature: true }),
    { workflowRunId: requestBody.workflowRunId, workflowRunAttempt: 1, commitSha: requestBody.commitSha },
    { fetchImpl: oidcFetch, now: () => NOW.getTime() },
  )
  assert.equal(result.verified, false)
  assert.equal(result.reason, 'github-oidc-signature-invalid')
})

test('read-only inventory sync verifies official USDT, native TRX, addresses and saves snapshot', async () => {
  const fixture = makeFixture()
  const oidcToken = createOidcToken()
  await withServer(fixture, async (url) => {
    const response = await postInventory(url, oidcToken)
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.verificationStatus, 'verified', JSON.stringify(payload))
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
    assert.equal(JSON.stringify(payload).includes(oidcToken), false)
    assert.equal(JSON.stringify(fixture.calls.persisted).includes(envSecretMarker()), false)
  })
})

test('inventory endpoint rejects unauthorized callers before contacting Fireblocks', async () => {
  const fixture = makeFixture()
  await withServer(fixture, async (url) => {
    const response = await postInventory(url, 'not-a-valid-oidc-token')
    assert.equal(response.status, 401)
    assert.equal(fixture.calls.fireblocks, 0)
    assert.equal(fixture.calls.persisted, null)
  })
})

test('inventory endpoint rejects a run context that does not match the signed OIDC identity', async () => {
  const fixture = makeFixture()
  await withServer(fixture, async (url) => {
    const response = await postInventory(url, createOidcToken(), { ...requestBody, workflowRunId: '987654321' })
    assert.equal(response.status, 401)
    assert.equal(fixture.calls.fireblocks, 0)
    assert.equal(fixture.calls.persisted, null)
  })
})

test('contradictory USDT contract metadata is blocked and recorded as a diagnostic', async () => {
  const fixture = makeFixture({ officialUsdtContract: 'T' + 'B'.repeat(33) })
  await withServer(fixture, async (url) => {
    const response = await postInventory(url)
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
    const response = await postInventory(url)
    const payload = await response.json()
    assert.equal(payload.verificationStatus, 'blocked')
    assert.equal(payload.checks.databaseReady, false)
  })
})

function envSecretMarker() {
  return 'test-api-key-not-real'
}

test('manual inventory workflow uses OIDC and carries no shared trigger secret', async () => {
  const { readFile } = await import('node:fs/promises')
  const workflow = await readFile(new URL('../.github/workflows/fireblocks-inventory-sync.yml', import.meta.url), 'utf8')
  assert.match(workflow, /id-token: write/)
  assert.match(workflow, /environment: fireblocks-readonly-sync/)
  assert.match(workflow, /audience=tron-token-studio-fireblocks-inventory/)
  assert.doesNotMatch(workflow, /FIREBLOCKS_SYNC_TRIGGER_TOKEN/)
  assert.doesNotMatch(workflow, /secrets\.FIREBLOCKS_SYNC/)
})

