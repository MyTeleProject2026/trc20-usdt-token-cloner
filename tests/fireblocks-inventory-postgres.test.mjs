import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const enabled = process.env.SPONSOR_PG_INTEGRATION === '1'

test('PostgreSQL persists and reads the latest sanitized Fireblocks inventory snapshot', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with the dedicated sponsor_test database',
}, async () => {
  const {
    initializeDatabase,
    persistFireblocksInventorySnapshot,
    getLatestFireblocksInventorySnapshot,
  } = await import('../server/database.mjs')

  const initialized = await initializeDatabase()
  assert.equal(initialized.ready, true)

  const suffix = BigInt('0x' + randomUUID().replaceAll('-', '')).toString().slice(0, 6).padStart(6, '0')
  const workflowRunId = String(Date.now()) + suffix
  const checkedAt = new Date(Date.now() + 60_000)
  const persisted = await persistFireblocksInventorySnapshot({
    workflowRunId,
    workflowRunAttempt: 1,
    repository: 'MyTeleProject2026/trc20-usdt-token-cloner',
    branch: 'main',
    commitSha: 'a'.repeat(40),
    verificationStatus: 'verified',
    checkedAt,
    configuration: {
      apiBase: 'https://api.fireblocks.io',
      vaultAccountId: '42',
      usdtAssetId: 'TRON_USDT',
      trxAssetId: 'TRX',
      treasuryAddress: 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2',
      signerMode: 'fireblocks',
      network: 'mainnet',
      usdtContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      usdtDecimals: 6,
      trxDecimals: 6,
      apiKeyConfigured: true,
      rsaKeyConfigured: true,
      secretKeyPath: '/etc/secrets/private.pem',
      privateKey: 'must-not-be-persisted',
    },
    checks: {
      fireblocksApiAuthenticated: true,
      vaultAccountVerified: true,
      officialUsdtAssetVerified: true,
      officialUsdtChainVerified: true,
      databaseReady: true,
    },
    balances: {
      fireblocksUsdtAvailableBaseUnits: '125000000',
      chainUsdtBalanceBaseUnits: '125000000',
      fireblocksTrxAvailableBaseUnits: '5000000',
      chainTrxBalanceSun: '5000000',
      privateKey: 'must-not-be-persisted',
    },
    reasons: [],
  })
  assert.equal(persisted.persisted, true)

  const latest = await getLatestFireblocksInventorySnapshot()
  assert.equal(latest.success, true)
  assert.equal(latest.snapshot.workflowRunId, workflowRunId)
  assert.equal(latest.snapshot.workflowRunAttempt, 1)
  assert.equal(latest.snapshot.verificationStatus, 'verified')
  assert.equal(latest.snapshot.configuration.vaultAccountId, '42')
  assert.equal(latest.snapshot.configuration.treasuryAddress, 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2')
  assert.equal(latest.snapshot.configuration.apiKeyConfigured, true)
  assert.equal(latest.snapshot.checks.officialUsdtAssetVerified, true)
  assert.equal(latest.snapshot.balances.chainUsdtBalanceBaseUnits, '125000000')
  assert.equal(Object.hasOwn(latest.snapshot.configuration, 'secretKeyPath'), false)
  assert.equal(Object.hasOwn(latest.snapshot.configuration, 'privateKey'), false)
  assert.equal(Object.hasOwn(latest.snapshot.balances, 'privateKey'), false)
})
