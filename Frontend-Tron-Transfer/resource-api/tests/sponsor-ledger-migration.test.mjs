import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../scripts/migrate-sponsor-ledger.mjs', import.meta.url))

test('Sponsor ledger migration refuses to run until writes are explicitly paused', () => {
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, SPONSOR_WRITES_PAUSED: 'false', SOURCE_DATABASE_URL: '', TARGET_DATABASE_URL: '' },
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /SPONSOR_WRITES_PAUSED=true/)
  assert.doesNotMatch(result.stderr, /DATABASE_URL/)
})

test('Sponsor ledger migration refuses identical source and target without leaking credentials', () => {
  const secret = 'not-a-real-password-sentinel'
  const url = `postgresql://user:${secret}@db.example.test:5432/sponsor?sslmode=require`
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, SPONSOR_WRITES_PAUSED: 'true', SOURCE_DATABASE_URL: url, TARGET_DATABASE_URL: url },
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /identities are the same/)
  assert.doesNotMatch(result.stderr, new RegExp(secret))
  assert.doesNotMatch(result.stdout, new RegExp(secret))
})

test('migration durably pauses the source before the read-only snapshot and keeps target paused', () => {
  const source = readFileSync(script, 'utf8')
  const sourcePause = source.indexOf("VALUES (1, TRUE, 'sponsor-ledger-migration')")
  const readOnlySnapshot = source.indexOf("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
  const targetPause = source.indexOf("VALUES (1, TRUE, 'post-migration-verification')")
  assert.ok(sourcePause >= 0)
  assert.ok(readOnlySnapshot > sourcePause)
  assert.ok(targetPause > readOnlySnapshot)
  assert.match(source, /SELECT writes_paused FROM public\.tron_transfer_sponsor_control/)
})
test('migration preserves prepared and signed transaction payloads and includes them in checksum verification', () => {
  const source = readFileSync(script, 'utf8')
  assert.match(source, /'prepared_transaction', 'signed_transaction'/)
  assert.match(source, /prepared_transaction JSONB/)
  assert.match(source, /signed_transaction JSONB/)
  assert.match(source, /canonicalValue\(row\[column\]\)/)
  assert.match(source, /Source Sponsor ledger schema is incomplete/)
})
