import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import test from 'node:test'
import { createOwnerAuthRouter } from '../server/routes/tron-wallet-auth.mjs'

const ownerAddress = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const treasuryAddress = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'
const privateKeyMarker = '1a'.repeat(32)
const databaseMarker = 'postgresql://do-not-return:diagnostic-secret@db.invalid:5432/private'
const passwordHash = `scrypt$${Buffer.alloc(16, 0x11).toString('base64url')}$${Buffer.alloc(64, 0x22).toString('base64url')}`

async function queryConfig(env, t) {
  const app = express()
  app.use('/api/auth/owner', createOwnerAuthRouter({ env }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const address = server.address()
  const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/owner/config`, {
    headers: { Accept: 'application/json' },
  })
  return { response, data: await response.json() }
}

function validEnvironment() {
  return {
    OWNER_WALLET_ADDRESS: ownerAddress,
    OWNER_PASSWORD_HASH: passwordHash,
    DATABASE_URL: databaseMarker,
    FRONTEND_ORIGIN: 'https://trc20-usdt-token-cloner.onrender.com',
    PACKAGED_APP_ORIGINS: 'tronstudio://app',
    TATUM_API_KEY: 'diagnostic-tatum-secret-do-not-return',
    TREASURY_OWNER_ADDRESS: ownerAddress,
    TREASURY_ADDRESS: treasuryAddress,
    TREASURY_PRIVATE_KEY: privateKeyMarker,
    TREASURY_MAX_PAYOUT_USDT: '100',
    TREASURY_DAILY_LIMIT_USDT: '1000',
    TREASURY_FEE_LIMIT_SUN: '50000000',
    TREASURY_WITHDRAWALS_ENABLED: 'true',
    TREASURY_SIGNER_MODE: 'env-hot-wallet',
  }
}

test('sanitized owner config reports required prerequisites without returning secrets or wallet addresses', async (t) => {
  const { response, data } = await queryConfig(validEnvironment(), t)
  assert.equal(response.status, 200)
  assert.equal(data.success, true)
  assert.equal(data.ownerConsole.configured, true)
  assert.equal(data.ownerConsole.ownerAddressConfigured, true)
  assert.equal(data.ownerConsole.passwordHashConfigured, true)
  assert.equal(data.ownerConsole.databaseConfigured, true)
  assert.equal(data.ownerConsole.hostedUiOriginAllowed, true)
  assert.equal(data.ownerConsole.packagedUiOriginAllowed, true)
  assert.equal(data.ownerConsole.registrationEnabled, false)
  assert.deepEqual(data.ownerConsole.requiredEnvironment, [])

  assert.equal(data.treasuryPayout.environmentComplete, true)
  assert.equal(data.treasuryPayout.ownerAddressesMatch, true)
  assert.equal(data.treasuryPayout.treasuryAddressConfigured, true)
  assert.equal(data.treasuryPayout.signerKeyConfigured, true)
  assert.equal(data.treasuryPayout.signerKeyValidFormat, true)
  assert.equal(data.treasuryPayout.maxPayoutLimitConfigured, true)
  assert.equal(data.treasuryPayout.dailyLimitConfigured, true)
  assert.equal(data.treasuryPayout.feeLimitConfigured, true)
  assert.equal(data.treasuryPayout.withdrawalsExplicitlyEnabled, true)
  assert.equal(data.treasuryPayout.signerModeConfigured, true)
  assert.deepEqual(data.treasuryPayout.missingEnvironment, [])

  // This is a config-shape check, not an on-chain funding or signing check.
  assert.equal(data.treasuryPayout.signerAddressMatchVerified, false)
  assert.equal(data.treasuryPayout.onChainFundingVerified, false)
  assert.equal(data.treasuryPayout.payoutAuthorized, false)
  assert.equal(data.ownerTreasuryFunding.onChainBalancesChecked, false)

  const serialized = JSON.stringify(data)
  for (const secret of [passwordHash, databaseMarker, privateKeyMarker, 'diagnostic-tatum-secret-do-not-return']) {
    assert.equal(serialized.includes(secret), false)
  }
  for (const address of [ownerAddress, treasuryAddress]) {
    assert.equal(serialized.includes(address), false)
  }
  assert.equal(/"privateKey"\s*:|"passwordHash"\s*:|"databaseUrl"\s*:|"apiKey"\s*:/i.test(serialized), false)
})

test('incomplete environment reports missing variable names and never asserts payout readiness', async (t) => {
  const { response, data } = await queryConfig({}, t)
  assert.equal(response.status, 200)
  assert.equal(data.ownerConsole.configured, false)
  assert.equal(data.ownerConsole.registrationEnabled, false)
  assert.ok(data.ownerConsole.requiredEnvironment.includes('OWNER_WALLET_ADDRESS (valid TRON Mainnet address)'))
  assert.ok(data.ownerConsole.requiredEnvironment.includes('OWNER_PASSWORD_HASH (valid scrypt hash)'))
  assert.ok(data.ownerConsole.requiredEnvironment.includes('DATABASE_URL'))

  assert.equal(data.treasuryPayout.environmentComplete, false)
  assert.equal(data.treasuryPayout.signerAddressMatchVerified, false)
  assert.equal(data.treasuryPayout.onChainFundingVerified, false)
  assert.equal(data.treasuryPayout.payoutAuthorized, false)
  assert.ok(data.treasuryPayout.missingEnvironment.some((item) => item.includes('TREASURY_PRIVATE_KEY')))
  assert.ok(data.treasuryPayout.missingEnvironment.some((item) => item.includes('TREASURY_WITHDRAWALS_ENABLED=true')))
})

test('owner address mismatch and malformed treasury key are reported as blockers', async (t) => {
  const env = {
    ...validEnvironment(),
    TREASURY_OWNER_ADDRESS: treasuryAddress,
    TREASURY_PRIVATE_KEY: 'not-a-private-key',
  }
  const { response, data } = await queryConfig(env, t)
  assert.equal(response.status, 200)
  assert.equal(data.ownerConsole.configured, true)
  assert.equal(data.treasuryPayout.environmentComplete, false)
  assert.equal(data.treasuryPayout.ownerAddressesMatch, false)
  assert.equal(data.treasuryPayout.signerKeyConfigured, true)
  assert.equal(data.treasuryPayout.signerKeyValidFormat, false)
  assert.ok(data.treasuryPayout.missingEnvironment.some((item) => item.includes('OWNER_WALLET_ADDRESS and TREASURY_OWNER_ADDRESS')))
  assert.ok(data.treasuryPayout.missingEnvironment.some((item) => item.includes('64 hex characters')))
})
