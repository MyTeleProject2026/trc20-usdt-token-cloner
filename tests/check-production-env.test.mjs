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
    FINCRA_PAYOUTS_ENABLED: 'false',
    ...overrides,
  }
}

test('environment preflight reports missing essentials without serializing values', () => {
  const env = { DATABASE_URL: 'postgresql://user:sensitive-password@localhost/db' }
  const report = inspectProductionEnvironment(env)
  const serialized = JSON.stringify(report)
  assert.equal(report.status, 'configuration-needs-attention')
  assert.equal(report.secretValuesDisplayed, false)
  assert.equal(report.releaseAuthorized, false)
  assert.ok(report.errors.includes('TATUM_API_KEY'))
  assert.ok(report.errors.includes('OWNER_WALLET_ADDRESS'))
  assert.equal(serialized.includes('sensitive-password'), false)
  assert.equal(serialized.includes('postgresql://'), false)
})

test('valid base configuration passes syntax checks without requiring disabled Fincra credentials', () => {
  const report = inspectProductionEnvironment(completeSyntacticEnv())
  const serialized = JSON.stringify(report)
  assert.equal(report.status, 'syntactic-preflight-passed')
  assert.deepEqual(report.errors, [])
  assert.equal(report.releaseAuthorized, false)
  assert.equal(report.checks.FINCRA_API_KEY.status, 'not-required-disabled')
  assert.equal(report.checks.FINCRA_PAYOUTS_ENABLED.status, 'disabled')
  for (const secret of ['do-not-print-db-password', 'do-not-print-tatum-secret', 'postgresql://', owner]) {
    assert.equal(serialized.includes(secret), false, 'report must not expose ' + secret)
  }
})

test('enabling Fincra payouts requires the Fincra business, secret, webhook and limit configuration', () => {
  const report = inspectProductionEnvironment(completeSyntacticEnv({
    FINCRA_PAYOUTS_ENABLED: 'true',
    FINCRA_API_BASE: 'https://sandboxapi.fincra.com',
    FINCRA_API_KEY: 'do-not-print-fincra-secret',
    FINCRA_BUSINESS_ID: 'business-123',
    FINCRA_WEBHOOK_SECRET: 'do-not-print-webhook-secret',
    FINCRA_SOURCE_CURRENCY: 'USDT',
    FINCRA_MAX_PAYOUT_USDT: '10',
    FINCRA_DAILY_LIMIT_USDT: '100',
  }))
  const serialized = JSON.stringify(report)
  assert.equal(report.status, 'syntactic-preflight-passed')
  assert.equal(report.checks.FINCRA_API_BASE.status, 'configured')
  assert.equal(report.checks.FINCRA_SOURCE_CURRENCY.status, 'configured')
  assert.equal(report.checks.FINCRA_MAX_PAYOUT_USDT.status, 'configured')
  assert.equal(report.checks.FINCRA_DAILY_LIMIT_USDT.status, 'configured')
  assert.equal(report.releaseAuthorized, false, 'syntax checks never authorize live payouts')
  assert.equal(report.warnings.includes('FINCRA_PAYOUTS_ENABLED'), true)
  assert.equal(serialized.includes('do-not-print-fincra-secret'), false)
  assert.equal(serialized.includes('do-not-print-webhook-secret'), false)
})

test('Fincra live payout preflight rejects unsupported source currencies and unsafe API origins', () => {
  const report = inspectProductionEnvironment(completeSyntacticEnv({
    FINCRA_PAYOUTS_ENABLED: 'true',
    FINCRA_API_BASE: 'https://attacker.example',
    FINCRA_API_KEY: 'configured',
    FINCRA_BUSINESS_ID: 'business-123',
    FINCRA_WEBHOOK_SECRET: 'configured-webhook-secret',
    FINCRA_SOURCE_CURRENCY: 'USD',
    FINCRA_MAX_PAYOUT_USDT: '10',
    FINCRA_DAILY_LIMIT_USDT: '100',
  }))
  assert.equal(report.checks.FINCRA_API_BASE.status, 'invalid')
  assert.equal(report.checks.FINCRA_SOURCE_CURRENCY.status, 'unsupported')
  assert.ok(report.errors.includes('FINCRA_API_BASE'))
  assert.ok(report.errors.includes('FINCRA_SOURCE_CURRENCY'))
})

test('preflight rejects mismatched owner and malformed sponsor addresses', () => {
  const report = inspectProductionEnvironment(completeSyntacticEnv({
    TREASURY_OWNER_ADDRESS: 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2',
    SPONSOR_FEE_MAINNET_ADDRESS: 'not-a-tron-address',
  }))
  assert.equal(report.checks.TREASURY_OWNER_ADDRESS.status, 'mismatch')
  assert.equal(report.checks.SPONSOR_FEE_MAINNET_ADDRESS.status, 'invalid')
  assert.ok(report.errors.includes('TREASURY_OWNER_ADDRESS'))
  assert.ok(report.errors.includes('SPONSOR_FEE_MAINNET_ADDRESS'))
})

test('preflight never reports production release authorization when the Fincra flag is enabled', () => {
  const report = inspectProductionEnvironment(completeSyntacticEnv({
    FINCRA_PAYOUTS_ENABLED: 'true',
    FINCRA_API_KEY: 'secret',
    FINCRA_BUSINESS_ID: 'business-123',
    FINCRA_WEBHOOK_SECRET: 'webhook-secret',
    FINCRA_SOURCE_CURRENCY: 'USDT',
    FINCRA_MAX_PAYOUT_USDT: '10',
    FINCRA_DAILY_LIMIT_USDT: '100',
  }))
  assert.equal(report.checks.FINCRA_PAYOUTS_ENABLED.status, 'enabled-needs-independent-release-approval')
  assert.ok(report.warnings.includes('FINCRA_PAYOUTS_ENABLED'))
  assert.equal(report.releaseAuthorized, false)
})

test('preflight validates six-decimal Fincra payout limits', () => {
  const valid = inspectProductionEnvironment(completeSyntacticEnv({
    FINCRA_PAYOUTS_ENABLED: 'true',
    FINCRA_API_KEY: 'secret',
    FINCRA_BUSINESS_ID: 'business-123',
    FINCRA_WEBHOOK_SECRET: 'webhook-secret',
    FINCRA_SOURCE_CURRENCY: 'USDT',
    FINCRA_MAX_PAYOUT_USDT: '0.25',
    FINCRA_DAILY_LIMIT_USDT: '100.125',
  }))
  assert.equal(valid.status, 'syntactic-preflight-passed')
  assert.equal(valid.checks.FINCRA_MAX_PAYOUT_USDT.status, 'configured')
  assert.equal(valid.checks.FINCRA_DAILY_LIMIT_USDT.status, 'configured')

  const invalid = inspectProductionEnvironment(completeSyntacticEnv({
    FINCRA_PAYOUTS_ENABLED: 'true',
    FINCRA_API_KEY: 'secret',
    FINCRA_BUSINESS_ID: 'business-123',
    FINCRA_WEBHOOK_SECRET: 'webhook-secret',
    FINCRA_SOURCE_CURRENCY: 'USDT',
    FINCRA_MAX_PAYOUT_USDT: '1.0000001',
    FINCRA_DAILY_LIMIT_USDT: '100',
  }))
  assert.equal(invalid.checks.FINCRA_MAX_PAYOUT_USDT.status, 'invalid')
  assert.ok(invalid.errors.includes('FINCRA_MAX_PAYOUT_USDT'))
})
