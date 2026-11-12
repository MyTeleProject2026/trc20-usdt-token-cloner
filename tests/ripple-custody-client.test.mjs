import test from 'node:test'
import assert from 'node:assert/strict'
import { createRippleCustodyClient, rippleCustodyConfiguration, RippleCustodyWriteDisabledError } from '../server/ripple-custody-client.mjs'

const env = {
  RIPPLE_CUSTODY_API_BASE: 'https://custody.example.invalid',
  RIPPLE_CUSTODY_BEARER_TOKEN: 'test-token',
  RIPPLE_CUSTODY_DOMAIN_ID: 'domain-1',
  RIPPLE_CUSTODY_OMNIBUS_ID: 'omnibus-1',
  RIPPLE_CUSTODY_TRX_TICKER_ID: 'ticker-1',
  RIPPLE_CUSTODY_TRON_LEDGER_ID: 'tron-ledger-1',
  RIPPLE_CUSTODY_NETWORK: 'testnet-unverified',
}

test('Ripple configuration requires HTTPS origin, bearer token and domain', () => {
  assert.equal(rippleCustodyConfiguration(env).configured, true)
  assert.equal(rippleCustodyConfiguration({ ...env, RIPPLE_CUSTODY_API_BASE: 'http://localhost' }).configured, false)
  assert.equal(rippleCustodyConfiguration({ ...env, RIPPLE_CUSTODY_API_BASE: 'https://user:pass@example.invalid' }).configured, false)
  assert.ok(rippleCustodyConfiguration({ ...env, RIPPLE_CUSTODY_BEARER_TOKEN: '' }).missing.includes('RIPPLE_CUSTODY_BEARER_TOKEN'))
})

test('read requests use configured origin and backend-only bearer token', async () => {
  const calls = []
  const client = createRippleCustodyClient({
    env,
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return { ok: true, status: 200, text: async () => '{"items":[]}' }
    },
  })
  await client.read.listTenants('omnibus/unsafe', 'domain-1')
  assert.equal(calls[0].url, 'https://custody.example.invalid/v1/domains/domain-1/omnibus/omnibus%2Funsafe/tenants')
  assert.equal(calls[0].options.headers.authorization, 'Bearer test-token')
  assert.equal(client.config.token, undefined)
})

test('withdrawal, intent approval and Gas Station mutations fail before network access', async () => {
  let calls = 0
  const client = createRippleCustodyClient({ env, fetchImpl: async () => { calls += 1; throw new Error('must not call') } })
  await assert.rejects(client.writes.createWithdrawal({}), RippleCustodyWriteDisabledError)
  await assert.rejects(client.writes.approveIntent({}), RippleCustodyWriteDisabledError)
  await assert.rejects(client.writes.createAccountSponsor({}), RippleCustodyWriteDisabledError)
  assert.equal(calls, 0)
})

test('provider failures are sanitized and malformed JSON is rejected', async () => {
  const rejected = createRippleCustodyClient({ env, fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'secret details' }) })
  await assert.rejects(rejected.read.getDomains(), (error) => error.status === 401 && error.code === 'ripple-custody-provider-rejected-request')
  const malformed = createRippleCustodyClient({ env, fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>' }) })
  await assert.rejects(malformed.read.getDomains(), (error) => error.code === 'ripple-custody-invalid-json-response')
})
