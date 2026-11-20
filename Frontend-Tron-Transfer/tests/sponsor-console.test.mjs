import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('Sponsor console exposes live Mainnet status and explicit gated transaction controls', async () => {
  const source = await readFile(new URL('../src/SponsorConsole.jsx', import.meta.url), 'utf8')
  assert.match(source, /\/api\/tron\/sponsor\/status/)
  assert.match(source, /\/api\/tron\/sponsor\/transaction\/execute/)
  assert.match(source, /CONFIRM TRON MAINNET SPONSOR TRANSACTION/)
  assert.match(source, /caps\?\.canStake/)
  assert.match(source, /caps\?\.canDelegate/)
  assert.match(source, /Reconcile Existing Transaction/)
  assert.match(source, /disabled title="Automatic unstaking is intentionally disabled"/)
  assert.doesNotMatch(source, /SPONSOR_MAINNET_PRIVATE_KEY/)
})
