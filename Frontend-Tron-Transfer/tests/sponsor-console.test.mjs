import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('Sponsor console exposes live Mainnet status and keeps unsafe transaction controls disabled', async () => {
  const source = await readFile(new URL('../src/SponsorConsole.jsx', import.meta.url), 'utf8')
  assert.match(source, /\/api\/tron\/sponsor\/status/)
  assert.match(source, /disabled title="Requires the reviewed server-side Stake 2\.0 signer"/)
  assert.match(source, /does not claim to stake, purchase, or delegate/)
})
