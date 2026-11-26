import test from 'node:test'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { ownerAdminDatabaseIdentityFingerprint, registerSponsorLedgerMigration } from '../scripts/register-sponsor-ledger-migration.mjs'

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


test('Sponsor API pinned migration checksum matches the versioned SQL migration byte-for-byte', async () => {
  const sql = await readFile(new URL('../migrations/20261126_sponsor_operations_ledger.sql', import.meta.url))
  const api = await readFile(new URL('../sponsor-api.mjs', import.meta.url), 'utf8')
  const pinned = api.match(/SPONSOR_LEDGER_MIGRATION_SHA256 = '([0-9a-f]{64})'/)?.[1]
  assert.ok(pinned, 'Sponsor API must pin the ledger migration checksum')
  assert.equal(createHash('sha256').update(sql).digest('hex'), pinned)
})


test('Sponsor migration registrar uses the exact Owner Admin fingerprint algorithm', () => {
  const url = 'postgresql://neondb_owner:placeholder@ep-curly-cherry-bej1ybw8-pooler.c-9.us-east-2.aws.neon.tech/Tron%20Transfer%20Resource%20Database?sslmode=require'
  const identity = JSON.stringify({
    hostname: 'ep-curly-cherry-bej1ybw8-pooler.c-9.us-east-2.aws.neon.tech',
    port: '5432',
    database: 'Tron Transfer Resource Database',
    username: 'neondb_owner',
  })
  assert.equal(ownerAdminDatabaseIdentityFingerprint(url), createHash('sha256').update(identity).digest('hex'))
})
