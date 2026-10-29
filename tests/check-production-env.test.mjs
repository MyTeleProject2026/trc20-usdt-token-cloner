import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectProductionEnvironment } from '../scripts/check-production-env.mjs'

const owner = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'

function completeSyntacticEnv(overrides = {}) {
  return {
    DATABASE_URL: 'postgresql://db-user:do-not-print-db-password@localhost:5432/app',
    TATUM_API_KEY: 'do-not-print-tatum-secret',
    FRONTEND_ORIGIN: 'https://trc20-usdt-token-cloner.onrender.com',
    OWNER_WALLET_ADDRESS: owner,
    TREASURY_OWNER_ADDRESS: owner,
    OWNER_PASSWORD_HASH: 'scrypt$' + 'a'.repeat(22) + '$' + 'b'.repeat(86),
    TREASURY_ADDRESS: owner,
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
    TREASURY_OWNER_ADDRESS: 'TAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    SPONSOR_FEE_MAINNET_ADDRESS: 'not-a-tron-address',
  }), {
    fileExists: () => true,
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
  })
  assert.equal(report.checks.TREASURY_WITHDRAWALS_ENABLED.status, 'enabled-needs-independent-release-approval')
  assert.ok(report.warnings.includes('TREASURY_WITHDRAWALS_ENABLED'))
  assert.equal(report.releaseAuthorized, false)
})
