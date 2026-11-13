import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

test('all TRON sponsored payout contracts compile with Solidity 0.8.25', () => {
  const result = spawnSync(process.execPath, ['scripts/compile-tron-sponsored-payouts.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /Compiled all five sponsored-payout contracts/)
})
