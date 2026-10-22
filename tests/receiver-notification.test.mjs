import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const history = await readFile(new URL('../src/ReceiverHistory.tsx', import.meta.url), 'utf8')

test('receiver history only announces newly verified on-chain events', () => {
  assert.ok(history.includes('record.verifiedOnChain === true'))
  assert.ok(history.includes("record.verificationStatus === 'verified-on-chain'"))
  assert.ok(history.includes('seenVerifiedKeys.current'))
  assert.ok(history.includes('historyInitialized.current'))
  assert.ok(history.includes('newlyVerified'))
  assert.ok(history.includes('Verified incoming transfer notification'))
})

test('notification is an in-app status and does not claim exchange credit', () => {
  assert.ok(history.includes('role="status" aria-live="polite"'))
  assert.ok(history.includes('Exchange credit is separate.'))
  assert.ok(history.includes('It is not an exchange notification or proof of exchange-account credit.'))
  assert.ok(history.includes('onClick={() => setNotification(null)}'))
})

test('first loaded history is a baseline and does not notify for old records', () => {
  assert.ok(history.includes('Initial history is a baseline, not a stream of alerts for old transfers.'))
  assert.ok(history.includes('seenVerifiedKeys.current.clear()'))
})
