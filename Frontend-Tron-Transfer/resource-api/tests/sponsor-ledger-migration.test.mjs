import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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
