import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { getDatabaseStatus } from '../server/database.mjs'

test('database storage is isolated to a project-specific schema and table set', async () => {
  const source = await readFile(new URL('../server/database.mjs', import.meta.url), 'utf8')
  assert.match(source, /const schema = 'trc20_token_clone'/)
  assert.match(source, /CREATE TABLE IF NOT EXISTS \$\{schema\}\.token_deployments/)
  assert.match(source, /CREATE TABLE IF NOT EXISTS \$\{schema\}\.transfer_verifications/)
  assert.match(source, /CREATE TABLE IF NOT EXISTS \$\{schema\}\.tracked_wallets/)
  assert.match(source, /CREATE TABLE IF NOT EXISTS \$\{schema\}\.audit_events/)
  assert.match(source, /CREATE TABLE IF NOT EXISTS \$\{schema\}\.sponsor_provider_applications/)
  assert.match(source, /CREATE TABLE IF NOT EXISTS \$\{schema\}\.wallet_auth_accounts/)
  assert.match(source, /CREATE TABLE IF NOT EXISTS \$\{schema\}\.wallet_auth_challenges/)
  assert.match(source, /CREATE TABLE IF NOT EXISTS \$\{schema\}\.wallet_auth_sessions/)
  assert.match(source, /CREATE TABLE IF NOT EXISTS \$\{schema\}\.wallet_auth_challenges/)
  assert.match(source, /CREATE TABLE IF NOT EXISTS \$\{schema\}\.wallet_auth_sessions/)
  assert.match(source, /wallet_auth_accounts_network_check/)
  assert.match(source, /wallet_auth_challenges_network_check/)
  assert.match(source, /wallet_auth_sessions_network_check/)
  assert.match(source, /CHECK \(network IN \('mainnet','nile','shasta'\)\)/)
  assert.match(source, /token_hash CHAR\(64\) PRIMARY KEY/)
  assert.doesNotMatch(source, /session_token TEXT/i)
  assert.match(source, /idx_ttc_provider_applications_status_created/)
  assert.match(source, /sponsor-provider-application-created/)
  assert.doesNotMatch(source, /CREATE TABLE IF NOT EXISTS public\./i)
  assert.match(source, /COMMENT ON TABLE/)
  assert.doesNotMatch(source, /CREATE TABLE IF NOT EXISTS public\./i)
})

test('database status does not claim persistence when no connection is configured', async () => {
  const previous = process.env.DATABASE_URL
  try {
    delete process.env.DATABASE_URL
    assert.deepEqual(await getDatabaseStatus(), { configured: false, ready: false })
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  }
})
