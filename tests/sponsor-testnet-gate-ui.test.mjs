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

test('sponsor console separates transaction preparation from explicit wallet signing', async () => {
  const source = await readFile(sourceUrl, 'utf8')
  const prepareStart = source.indexOf('const prepareSigningIntent = async () => {')
  const signStart = source.indexOf('const signAndSubmit = async () => {', prepareStart)
  const verifyStart = source.indexOf('const verifyReceiverSettlement', signStart)
  assert.ok(prepareStart >= 0 && signStart > prepareStart && verifyStart > signStart)
  const prepareFunction = source.slice(prepareStart, signStart)
  assert.match(prepareFunction, /signingIntentPersisted !== true/)
  assert.doesNotMatch(prepareFunction, /tronWeb\.trx\.sign/)
  assert.match(source, /hasPreparedCurrentIntent \? signAndSubmit\(\) : prepareSigningIntent\(\)/)
  assert.match(source, /The exact unsigned transaction is prepared and persisted/)
  assert.match(source, /signedTransaction\.raw_data_hex/)
  assert.match(source, /Persisted transaction ID/)
  assert.match(source, /Signing expiry/)
})
