import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createSponsorResourceApi } from '../sponsor-api.mjs'
import { REQUIRED_PRODUCTION_ACCEPTANCE_CHECKS } from '../production-acceptance-assessment.mjs'

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
  assert.equal(response.body.acceptance.checks.some(item => item.id === 'sponsor-local-transaction-signer' && item.state === 'blocked'), true)
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


test('production smoke requires every acceptance gate emitted by the Sponsor API', async () => {
  const source = await readFile(new URL('../scripts/production-acceptance-smoke.mjs', import.meta.url), 'utf8')
  const assessment = await readFile(new URL('../production-acceptance-assessment.mjs', import.meta.url), 'utf8')
  const sponsorApi = await readFile(new URL('../sponsor-api.mjs', import.meta.url), 'utf8')
  for (const id of REQUIRED_PRODUCTION_ACCEPTANCE_CHECKS) {
    assert.ok(sponsorApi.includes("id: '" + id + "'"), 'Sponsor API does not emit required acceptance check: ' + id)
  }
  assert.match(source, /evaluateProductionAcceptance/)
  assert.ok(source.includes('if (!result.passed) process.exitCode = 1'))
  assert.ok(assessment.includes('missingChecks.length === 0'))
  assert.ok(assessment.includes('blockedChecks.length === 0'))
  assert.ok(assessment.includes('ready-for-independent-review'))
  assert.doesNotMatch(assessment, /admin-second-factor-configured/)
})
