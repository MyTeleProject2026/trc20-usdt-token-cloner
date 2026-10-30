import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { inspectProductionEnvironment } from '../scripts/check-production-env.mjs'

const owner = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const rsa4096Pem = generateKeyPairSync('rsa', { modulusLength: 4096 })
  .privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()

const readValidFireblocksKey = () => rsa4096Pem

function completeSyntacticEnv(overrides = {}) {
  return {
    DATABASE_URL: 'postgresql://db-user:do-not-print-db-password@localhost:5432/app',
    TATUM_API_KEY: 'do-not-print-tatum-secret',
    FRONTEND_ORIGIN: 'https://trc20-usdt-token-cloner.onrender.com',
    OWNER_WALLET_ADDRESS: owner,
    TREASURY_OWNER_ADDRESS: owner,
    OWNER_PASSWORD_HASH: 'scrypt$' + 'a'.repeat(22) + '$' + 'b'.repeat(86),
    TREASURY_ADDRESS: owner,
    TREASURY_MAX_PAYOUT_USDT: '10',
    TREASURY_DAILY_LIMIT_USDT: '100',
    TREASURY_MAX_PAYOUT_TRX: '10',
    TREASURY_DAILY_LIMIT_TRX: '100',
    TREASURY_FEE_LIMIT_SUN: '50000000',
    TREASURY_SIGNER_MODE: 'fireblocks',
    FIREBLOCKS_API_BASE: 'https://api.fireblocks.io',
    FIREBLOCKS_API_KEY: 'do-not-print-fireblocks-key',
    FIREBLOCKS_SECRET_KEY_PATH: '/etc/secrets/fireblocks_api_private_key.pem',
    FIREBLOCKS_VAULT_ACCOUNT_ID: '123',
    FIREBLOCKS_USDT_ASSET_ID: 'TRON_USDT',
    FIREBLOCKS_TRX_ASSET_ID: 'TRX',
    TREASURY_WITHDRAWALS_ENABLED: 'false',
    TREASURY_TRX_WITHDRAWALS_ENABLED: 'false',
    SPONSOR_MAINNET_BUDGET_ACTIVATION_ENABLED: 'false',
    SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED: 'false',
    ...overrides,
  }
}

test('environment preflight reports missing essentials without serializing any values', () => {
  const env = { DATABASE_URL: 'postgresql://user:sensitive-password@localhost/db' }
  const report = inspectProductionEnvironment(env, { fileExists: () => false })
  const serialized = JSON.stringify(report)

  assert.equal(report.status, 'configuration-needs-attention')
  assert.equal(report.secretValuesDisplayed, false)
  assert.equal(report.releaseAuthorized, false)
  assert.ok(report.errors.includes('TATUM_API_KEY'))
  assert.ok(report.errors.includes('OWNER_WALLET_ADDRESS'))
  assert.equal(serialized.includes('sensitive-password'), false)
  assert.equal(serialized.includes('postgresql://'), false)
})

test('syntactically valid configuration reports names and statuses only, never values', () => {
  const report = inspectProductionEnvironment(completeSyntacticEnv(), {
    fileExists: (path) => path === '/etc/secrets/fireblocks_api_private_key.pem',
    readSecretFile: readValidFireblocksKey,
  })
  const serialized = JSON.stringify(report)

  assert.equal(report.status, 'syntactic-preflight-passed')
  assert.deepEqual(report.errors, [])
  assert.equal(report.releaseAuthorized, false, 'syntactic checks cannot authorize real payouts')
  assert.equal(report.checks.OWNER_WALLET_ADDRESS.status, 'configured')
  assert.equal(report.checks.TREASURY_OWNER_ADDRESS.status, 'configured')
  assert.equal(report.checks.FIREBLOCKS_SECRET_KEY_PATH.status, 'configured')
  assert.equal(report.checks.TREASURY_WITHDRAWALS_ENABLED.status, 'disabled')
  for (const secret of [
    'do-not-print-db-password',
    'do-not-print-tatum-secret',
    'do-not-print-fireblocks-key',
    'postgresql://',
    owner,
  ]) {
    assert.equal(serialized.includes(secret), false, 'report must not expose ' + secret)
  }
})

test('preflight rejects mismatched owner/treasury owner and malformed sponsor addresses', () => {
  const report = inspectProductionEnvironment(completeSyntacticEnv({
    TREASURY_OWNER_ADDRESS: 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2',
    SPONSOR_FEE_MAINNET_ADDRESS: 'not-a-tron-address',
  }), {
    fileExists: () => true,
    readSecretFile: readValidFireblocksKey,
  })
  assert.equal(report.checks.TREASURY_OWNER_ADDRESS.status, 'mismatch')
  assert.equal(report.checks.SPONSOR_FEE_MAINNET_ADDRESS.status, 'invalid')
  assert.ok(report.errors.includes('TREASURY_OWNER_ADDRESS'))
  assert.ok(report.errors.includes('SPONSOR_FEE_MAINNET_ADDRESS'))
})

test('preflight warns when any transfer gate is enabled and never reports production release authorization', () => {
  const report = inspectProductionEnvironment(completeSyntacticEnv({
    TREASURY_WITHDRAWALS_ENABLED: 'true',
  }), {
    fileExists: () => true,
    readSecretFile: readValidFireblocksKey,
  })
  assert.equal(report.checks.TREASURY_WITHDRAWALS_ENABLED.status, 'enabled-needs-independent-release-approval')
  assert.ok(report.warnings.includes('TREASURY_WITHDRAWALS_ENABLED'))
  assert.equal(report.releaseAuthorized, false)
})

test('preflight accepts valid decimal payout limits and rejects excess fractional precision', () => {
  const valid = inspectProductionEnvironment(completeSyntacticEnv({
    TREASURY_MAX_PAYOUT_USDT: '0.25',
    TREASURY_DAILY_LIMIT_USDT: '100.125',
    TREASURY_MAX_PAYOUT_TRX: '1.000001',
    TREASURY_DAILY_LIMIT_TRX: '2.5',
  }), {
    fileExists: () => true,
    readSecretFile: readValidFireblocksKey,
  })
  assert.equal(valid.status, 'syntactic-preflight-passed')
  for (const key of [
    'TREASURY_MAX_PAYOUT_USDT',
    'TREASURY_DAILY_LIMIT_USDT',
    'TREASURY_MAX_PAYOUT_TRX',
    'TREASURY_DAILY_LIMIT_TRX',
  ]) {
    assert.equal(valid.checks[key].status, 'configured', key + ' should accept decimal amounts')
  }

  const invalid = inspectProductionEnvironment(completeSyntacticEnv({
    TREASURY_MAX_PAYOUT_USDT: '1.0000001',
  }), {
    fileExists: () => true,
    readSecretFile: readValidFireblocksKey,
  })
  assert.equal(invalid.checks.TREASURY_MAX_PAYOUT_USDT.status, 'invalid')
  assert.ok(invalid.errors.includes('TREASURY_MAX_PAYOUT_USDT'))
})

test('preflight rejects a readable but undersized Fireblocks RSA private key without exposing it', () => {
  const weakPem = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  const report = inspectProductionEnvironment(completeSyntacticEnv(), {
    fileExists: () => true,
    readSecretFile: () => weakPem,
  })
  const serialized = JSON.stringify(report)
  assert.equal(report.checks.FIREBLOCKS_SECRET_KEY_PATH.status, 'invalid-key-size')
  assert.ok(report.errors.includes('FIREBLOCKS_SECRET_KEY_PATH'))
  assert.equal(report.status, 'configuration-needs-attention')
  assert.equal(serialized.includes('BEGIN PRIVATE KEY'), false)
  assert.equal(serialized.includes(weakPem), false)
})

test('preflight rejects unreadable or malformed Fireblocks PEM material without revealing it', () => {
  const report = inspectProductionEnvironment(completeSyntacticEnv(), {
    fileExists: () => true,
    readSecretFile: () => 'not-a-private-key',
  })
  assert.equal(report.checks.FIREBLOCKS_SECRET_KEY_PATH.status, 'invalid-key-file')
  assert.ok(report.errors.includes('FIREBLOCKS_SECRET_KEY_PATH'))
  assert.equal(JSON.stringify(report).includes('not-a-private-key'), false)
})
