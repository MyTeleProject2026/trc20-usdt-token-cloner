import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/RuntimeObservatory.jsx', import.meta.url), 'utf8')

test('runtime observatory suspends background polling while the document is hidden', () => {
  assert.match(source, /document\.visibilityState === 'hidden'/)
  assert.match(source, /document\.addEventListener\('visibilitychange', handleVisibilityChange\)/)
  assert.match(source, /document\.removeEventListener\('visibilitychange', handleVisibilityChange\)/)
  assert.match(source, /window\.setInterval\(refreshRuntime, 1000\)/)
  assert.match(source, /window\.setInterval\(refreshTransactions, 10_000\)/)
  assert.match(source, /window\.setInterval\(refreshRenderEvents, 30_000\)/)
  assert.match(source, /window\.setInterval\(refreshUptimeHistory, 60_000\)/)
})

test('runtime observatory clears all polling timers on hide and unmount', () => {
  assert.match(source, /const stopPolling = \(\) => \{/)
  assert.match(source, /timers\.forEach\(timer => window\.clearInterval\(timer\)\)/)
  assert.match(source, /const handleVisibilityChange = \(\) => \{\s*stopPolling\(\)/)
  assert.match(source, /return \(\) => \{\s*stopPolling\(\)/)
})
