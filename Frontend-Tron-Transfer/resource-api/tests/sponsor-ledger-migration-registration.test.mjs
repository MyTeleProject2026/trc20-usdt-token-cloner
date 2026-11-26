import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { registerSponsorLedgerMigration } from '../scripts/register-sponsor-ledger-migration.mjs'

test('Sponsor ledger migration registrar refuses an unpinned production database identity', async () => {
  await assert.rejects(
    registerSponsorLedgerMigration({
      env: {
        OWNER_ADMIN_DATABASE_URL: 'postgresql://operator:placeholder@db.example.invalid/Tron%20Transfer%20Resource%20Database',
        OWNER_ADMIN_EXPECTED_DATABASE_IDENTITY_SHA256: '0'.repeat(64),
      },
    }),
    /database identity did not match the pinned fingerprint/,
  )
})

test('versioned Sponsor ledger migration preserves the paused write-control row', async () => {
  const sql = await readFile(new URL('../migrations/20261126_sponsor_operations_ledger.sql', import.meta.url), 'utf8')
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.tron_transfer_sponsor_operations/)
  assert.match(sql, /operation IN \('stake','delegate','undelegate','unstake','withdraw','topup'\)/)
  assert.match(sql, /status IN \('reserved','signed-not-broadcast','broadcast-unknown','confirmed','failed'\)/)
  assert.match(sql, /writes_paused BOOLEAN NOT NULL DEFAULT TRUE/)
  assert.match(sql, /VALUES \(1, TRUE, 'schema-bootstrap-requires-explicit-cutover'\)/)
  assert.match(sql, /ON CONFLICT \(id\) DO NOTHING/)
})
