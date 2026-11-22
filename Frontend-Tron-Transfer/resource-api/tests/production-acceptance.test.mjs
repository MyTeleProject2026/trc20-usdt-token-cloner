import test from 'node:test'
import assert from 'node:assert/strict'
import { createSponsorResourceApi } from '../sponsor-api.mjs'

test('production acceptance endpoint is read-only, secret-free, and keeps execution disabled', async () => {
  let databaseCalls = 0
  let response
  const api = createSponsorResourceApi({
    env: {
      TRON_OWNER_ADDRESS: 'TOwnerAddressConfiguredForTestOnly',
      SPONSOR_MAINNET_ADDRESS: 'TSponsorAddressConfiguredForTestOnly',
      SPONSOR_MAINNET_PRIVATE_KEY: 'never-return-this-secret',
      SPONSOR_ADMIN_TOKEN: 'admin-secret-that-must-not-be-returned',
      SPONSOR_SESSION_SECRET: 'session-secret-that-must-not-be-returned-123456',
    },
    allowedAddress: 'TOwnerAddressConfiguredForTestOnly',
    engine: {
      readiness: () => ({
        configured: false,
        enabled: false,
        broadcastAvailable: false,
        ownerAddress: 'TOwnerAddressConfiguredForTestOnly',
        sponsorAddress: null,
        feePolicy: {},
        stakingPolicy: {},
        ownerTopupPolicy: {},
      }),
    },
    getDatabase: () => {
      databaseCalls += 1
      throw new Error('database must not be opened when no URL is configured')
    },
    send: (_res, status, body) => { response = { status, body } },
  })
  const handled = await api.handle(
    { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } },
    {},
    new URL('https://resource-api.example/api/acceptance/production'),
    null,
  )
  assert.equal(handled, true)
  assert.equal(response.status, 200)
  assert.equal(response.body.acceptance.executionEnabled, false)
  assert.equal(response.body.acceptance.state, 'blocked')
  assert.equal(response.body.acceptance.checks.some(item => item.id === 'sponsor-signer-address-match' && item.state === 'blocked'), true)
  assert.equal(response.body.acceptance.checks.some(item => item.id === 'writes-remain-paused-until-release' && item.state === 'passed'), true)
  assert.equal(response.body.transactionExecutionAvailable, false)
  assert.equal(databaseCalls, 0)
  const serialized = JSON.stringify(response.body)
  assert.equal(serialized.includes('never-return-this-secret'), false)
  assert.equal(serialized.includes('admin-secret-that-must-not-be-returned'), false)
  assert.equal(serialized.includes('session-secret-that-must-not-be-returned'), false)
})

test('unknown acceptance paths are not claimed by the Sponsor API', async () => {
  const api = createSponsorResourceApi({
    env: {},
    engine: { readiness: () => ({}) },
    send: () => {},
  })
  const handled = await api.handle(
    { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } },
    {},
    new URL('https://resource-api.example/api/acceptance/not-a-route'),
    null,
  )
  assert.equal(handled, false)
})
