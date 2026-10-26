import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const sourceUrl = new URL('../src/SponsorSignerConsole.tsx', import.meta.url)

test('sponsor console distinguishes the live Shasta/Nile feature gate from production readiness', async () => {
  const source = await readFile(sourceUrl, 'utf8')
  assert.match(source, /approvalConfiguration\?\.testnetSignedBroadcastGateEnabled === true/)
  assert.match(source, /signing-broadcast gate:/)
  assert.match(source, /This gate does not approve a reservation or confirm a transfer was sent/)
  assert.match(source, /Mainnet is not available in this console/)
})
