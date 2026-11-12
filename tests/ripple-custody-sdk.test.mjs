import test from 'node:test'
import assert from 'node:assert/strict'
import { createRippleCustodyClient, rippleCustodyConfiguration, RippleCustodyApiError, RippleCustodyWriteDisabledError } from '../server/ripple-custody-sdk.mjs'

const env = {
  RC_CONFIG_FILE: '/tmp/ripple-custody-test.toml',
  RC_CLIENT_ID: 'service-client',
  RC_CLIENT_SECRET: 'test-secret',
  RIPPLE_CUSTODY_NETWORK: 'sandbox-unverified',
}

test('service authentication requires client ID and client secret', () => {
  assert.equal(rippleCustodyConfiguration(env).configured, true)
  assert.equal(rippleCustodyConfiguration({ ...env, RC_CLIENT_SECRET: '' }).configured, false)
  assert.deepEqual(rippleCustodyConfiguration({ ...env, RC_CLIENT_ID: '' }).missing, ['RC_CLIENT_ID'])
})

test('official SDK is used for domain reads and client is closed', async () => {
  let constructed = false
  let closed = false
  const sdkModule = {
    loadConfiguration: (path) => {
      assert.equal(path, env.RC_CONFIG_FILE)
      return { grant: 'client_credentials' }
    },
    CustodyClient: class {
      constructor(config) { constructed = config.grant === 'client_credentials'; this.governance = { domains: { list: async (args) => { assert.equal(args.autoPaginate, true); return [{ data: { id: 'domain-a' } }] } } } }
      async close() { closed = true }
    },
  }
  const client = await createRippleCustodyClient({ env, sdkModule })
  assert.equal(constructed, true)
  assert.equal((await client.read.getDomains())[0].data.id, 'domain-a')
  await client.close()
  assert.equal(closed, true)
})

test('missing SDK configuration and unavailable SDK fail closed', async () => {
  await assert.rejects(createRippleCustodyClient({ env: { ...env, RC_CLIENT_SECRET: '' }, sdkModule: {} }), (error) => error instanceof RippleCustodyApiError && error.code === 'ripple-custody-service-auth-not-configured')
  await assert.rejects(createRippleCustodyClient({ env, sdkModule: {} }), (error) => error instanceof RippleCustodyApiError && error.code === 'ripple-custody-config-file-unavailable')
})

test('all value-moving operations remain disabled', async () => {
  const client = await createRippleCustodyClient({
    env,
    sdkModule: {
      loadConfiguration: () => ({}),
      CustodyClient: class { constructor() { this.governance = { domains: { list: async () => [] } } } },
    },
  })
  await assert.rejects(client.writes.createWithdrawal({}), RippleCustodyWriteDisabledError)
  await assert.rejects(client.writes.approveIntent({}), RippleCustodyWriteDisabledError)
})
