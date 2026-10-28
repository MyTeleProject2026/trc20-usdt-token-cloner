import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import test from 'node:test'
import { createOwnerAuthRouter } from '../server/routes/tron-wallet-auth.mjs'

const ownerAddress = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const databaseMarker = 'postgresql://diagnostic-user:diagnostic-password@db.invalid:5432/private'
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
    DATABASE_URL: databaseMarker,
    FRONTEND_ORIGIN: 'https://trc20-usdt-token-cloner.onrender.com',
    PACKAGED_APP_ORIGINS: 'tronstudio://app',
    // These values are deliberately present as tripwires: a public
    // pre-login endpoint must not report any treasury signer or secret posture.
    TREASURY_PRIVATE_KEY: '1a'.repeat(32),
    TREASURY_ADDRESS: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb',
    TREASURY_WITHDRAWALS_ENABLED: 'true',
    OWNER_PASSWORD_HASH: passwordHash,
  }
}

test('owner console config reports readiness booleans and missing variable names only', async (t) => {
  const env = validEnvironment()
  env.OWNER_PASSWORD_HASH = passwordHash
  const { response, data } = await queryConfig(env, t)

  assert.equal(response.status, 200)
  assert.equal(data.success, true)
  assert.equal(data.ownerConsole.configured, true)
  assert.equal(data.ownerConsole.ownerAddressConfigured, true)
  assert.equal(data.ownerConsole.passwordHashConfigured, true)
  assert.equal(data.ownerConsole.databaseConfigured, true)
  assert.equal(data.ownerConsole.allowedOriginConfigured, true)
  assert.equal(data.ownerConsole.hostedUiOriginAllowed, true)
  assert.equal(data.ownerConsole.packagedUiOriginAllowed, true)
  assert.equal(data.ownerConsole.registrationEnabled, false)
  assert.deepEqual(data.ownerConsole.requiredEnvironment, [])
  assert.equal('treasuryPayout' in data, false)
  assert.equal('ownerTreasuryFunding' in data, false)

  const serialized = JSON.stringify(data)
  for (const secret of [ownerAddress, passwordHash, databaseMarker, '1a'.repeat(32), 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb']) {
    assert.equal(serialized.includes(secret), false)
  }
  for (const forbiddenKey of ['ownerAddress', 'treasuryAddress', 'privateKey', 'passwordHash', 'databaseUrl', 'apiKey', 'sessionToken']) {
    assert.equal(Object.hasOwn(data, forbiddenKey), false)
    assert.equal(serialized.includes(`"${forbiddenKey}"`), false)
  }
})

test('incomplete owner-console environment lists missing variable names without revealing values', async (t) => {
  const { response, data } = await queryConfig({}, t)
  assert.equal(response.status, 200)
  assert.equal(data.success, true)
  assert.equal(data.ownerConsole.configured, false)
  assert.equal(data.ownerConsole.registrationEnabled, false)
  assert.ok(data.ownerConsole.requiredEnvironment.includes('OWNER_WALLET_ADDRESS (valid TRON Mainnet address)'))
  assert.ok(data.ownerConsole.requiredEnvironment.includes('OWNER_PASSWORD_HASH (valid scrypt hash)'))
  assert.ok(data.ownerConsole.requiredEnvironment.includes('DATABASE_URL'))
  assert.ok(data.ownerConsole.requiredEnvironment.includes('FRONTEND_ORIGIN and/or PACKAGED_APP_ORIGINS'))
  assert.equal(data.ownerConsole.hostedUiOriginAllowed, false)
  assert.equal(data.ownerConsole.packagedUiOriginAllowed, false)
  assert.equal('treasuryPayout' in data, false)
})

test('invalid owner address and malformed password hash keep owner console disabled', async (t) => {
  const { response, data } = await queryConfig({
    OWNER_WALLET_ADDRESS: 'not-a-tron-address',
    OWNER_PASSWORD_HASH: 'not-a-hash',
    DATABASE_URL: databaseMarker,
    FRONTEND_ORIGIN: 'https://trc20-usdt-token-cloner.onrender.com',
  }, t)
  assert.equal(response.status, 200)
  assert.equal(data.ownerConsole.configured, false)
  assert.equal(data.ownerConsole.ownerAddressConfigured, false)
  assert.equal(data.ownerConsole.passwordHashConfigured, false)
  assert.ok(data.ownerConsole.requiredEnvironment.some((item) => item.includes('OWNER_WALLET_ADDRESS')))
  assert.ok(data.ownerConsole.requiredEnvironment.some((item) => item.includes('OWNER_PASSWORD_HASH')))
  assert.equal(JSON.stringify(data).includes(databaseMarker), false)
})
