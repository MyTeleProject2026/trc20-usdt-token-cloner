import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('Render Blueprint preserves Neon and does not provision a Render database or wallet secrets', async () => {
  const blueprint = await readFile(new URL('../../../render.yaml', import.meta.url), 'utf8')
  assert.match(blueprint, /- key: DATABASE_URL\n\s+sync: false/)
  assert.match(blueprint, /- key: TATUM_API_KEY\n\s+sync: false/)
  assert.match(blueprint, /- key: TRONGRID_API_KEY\n\s+sync: false/)
  for (const key of [
    'DATABASE_URL_POOLED', 'SPONSOR_DATABASE_URL', 'SPONSOR_DATABASE_URL_POOLED',
    'OWNER_ADMIN_DATABASE_URL', 'OWNER_ADMIN_EXPECTED_DATABASE_IDENTITY_SHA256', 'TRON_OWNER_ENROLLMENT_TOKEN', 'TRON_SPONSOR_ENROLLMENT_TOKEN',
    'OWNER_OPERATION_EXECUTION_ENABLED', 'TRAX_DEPLOYMENT_EXECUTION_ENABLED',
    'TRAX_DEPLOYMENT_ARTIFACT_SHA256', 'SPONSOR_TRANSACTION_ENGINE_ENABLED',
    'SPONSOR_MAINNET_BROADCAST_ENABLED', 'SPONSOR_WRITES_RELEASE_ENABLED',
    'SPONSOR_LIQUID_RESERVE_TRX', 'SPONSOR_STAKING_ENABLED',
    'SPONSOR_MAX_AUTOMATIC_STAKE_TRX', 'SPONSOR_MAX_OWNER_TOPUP_TRX', 'SPONSOR_MAX_TX_FEE_SUN',
    'RENDER_API_KEY', 'RENDER_FRONTEND_SERVICE_ID', 'RENDER_RESOURCE_API_SERVICE_ID',
  ]) assert.match(blueprint, new RegExp('- key: ' + key + '\\n\\s+sync: false'), 'missing operator-managed Render variable: ' + key)
  assert.equal((blueprint.match(/^  - type: web$/gm) || []).length, 1, 'Blueprint must keep exactly the existing Resource API service')
  assert.match(blueprint, /name: tron-transfer-resource-api/)
  assert.match(blueprint, /branch: ui\\/modern-crypto-dashboard-theme/)
  assert.doesNotMatch(blueprint, /^databases:/m)
  assert.doesNotMatch(blueprint, /fromDatabase:/)
  assert.doesNotMatch(blueprint, /PRIVATE_KEY|MNEMONIC|SEED_PHRASE/i)
})

test('server environment example documents existing production gates without embedding credentials', async () => {
  const example = await readFile(new URL('../../../.env.example', import.meta.url), 'utf8')
  for (const key of [
    'DATABASE_URL=', 'OWNER_ADMIN_DATABASE_URL=', 'SPONSOR_DATABASE_URL=',
    'TATUM_API_KEY=', 'TRONGRID_API_KEY=', 'TRON_OWNER_ADDRESS=',
    'SPONSOR_MAINNET_ADDRESS=', 'TRON_OWNER_ENROLLMENT_TOKEN=',
    'TRON_SPONSOR_ENROLLMENT_TOKEN=', 'OWNER_ADMIN_EXPECTED_DATABASE_IDENTITY_SHA256=',
    'OWNER_OPERATION_EXECUTION_ENABLED=false', 'SPONSOR_TRANSACTION_ENGINE_ENABLED=false',
    'SPONSOR_MAINNET_BROADCAST_ENABLED=false', 'SPONSOR_WRITES_RELEASE_ENABLED=false',
    'TRAX_SOURCE_SHA256=', 'TRAX_RUNTIME_BYTECODE_SHA256=',
    'RENDER_API_KEY=', 'RENDER_FRONTEND_SERVICE_ID=srv-dblmrad6e07s739cs2lg',
    'RENDER_RESOURCE_API_SERVICE_ID=srv-dbrjpq56e07s73bueevg',
  ]) assert.ok(example.includes(key), 'missing server configuration entry: ' + key)
  assert.doesNotMatch(example, /(?:PRIVATE_KEY|MNEMONIC|SEED_PHRASE|PASSWORD_HASH)=/i)
  assert.match(example, /Never expose any value below through Vite\/VITE_\* frontend variables/)
  const values = Object.fromEntries(example.split(/\r?\n/).filter(line => /^[A-Z][A-Z0-9_]*=/.test(line)).map(line => {
    const separator = line.indexOf('=')
    return [line.slice(0, separator), line.slice(separator + 1)]
  }))
  for (const key of [
    'DATABASE_URL', 'DATABASE_URL_POOLED', 'OWNER_ADMIN_DATABASE_URL',
    'SPONSOR_DATABASE_URL', 'SPONSOR_DATABASE_URL_POOLED', 'TATUM_API_KEY',
    'TRONGRID_API_KEY', 'RENDER_API_KEY', 'TRON_OWNER_ENROLLMENT_TOKEN',
    'TRON_SPONSOR_ENROLLMENT_TOKEN', 'OWNER_ADMIN_EXPECTED_DATABASE_IDENTITY_SHA256',
    'SPONSOR_SESSION_SECRET',
  ]) assert.equal(values[key], '', key + ' must never contain a committed credential or production identity pin')
  for (const key of [
    'OWNER_OPERATION_LEDGER_DURABLE', 'OWNER_OPERATION_LEDGER_BACKUP_VERIFIED',
    'OWNER_OPERATION_LEDGER_RESTORE_TESTED', 'OWNER_OPERATION_EXECUTION_ENABLED',
    'SPONSOR_LEDGER_DURABLE', 'SPONSOR_LEDGER_BACKUP_VERIFIED',
    'SPONSOR_LEDGER_RESTORE_TESTED', 'SPONSOR_TRANSACTION_ENGINE_ENABLED',
    'SPONSOR_MAINNET_BROADCAST_ENABLED', 'SPONSOR_WRITES_RELEASE_ENABLED',
    'TRAX_DEPLOYMENT_EXECUTION_ENABLED', 'TRAX_DEPLOYMENT_LEDGER_DURABLE',
    'TRAX_DEPLOYMENT_LEDGER_BACKUP_VERIFIED', 'TRAX_DEPLOYMENT_LEDGER_RESTORE_TESTED',
  ]) assert.equal(values[key], 'false', key + ' must default to fail-closed')
})
