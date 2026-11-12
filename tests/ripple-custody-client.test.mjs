import test from 'node:test'
import assert from 'node:assert/strict'
import { rippleCustodyConfiguration, RippleCustodyWriteDisabledError } from '../server/ripple-custody-client.mjs'

test('legacy bearer-token configuration is no longer accepted', () => {
  const config = rippleCustodyConfiguration({
    RIPPLE_CUSTODY_API_BASE: 'https://vault.example.invalid',
    RIPPLE_CUSTODY_BEARER_TOKEN: 'should-not-be-used',
  })
  assert.equal(config.configured, false)
  assert.equal(config.authMode, 'client_credentials')
  assert.ok(config.missing.includes('RC_CLIENT_ID or client_id in config file'))
  assert.ok(config.missing.includes('RC_CLIENT_SECRET'))
})

test('mutation guard remains a dedicated fail-closed error', async () => {
  const error = new RippleCustodyWriteDisabledError()
  assert.equal(error.code, 'ripple-custody-value-mutations-disabled')
})
