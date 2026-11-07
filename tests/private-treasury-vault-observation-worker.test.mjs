import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PRIVATE_TREASURY_VAULT_WORKER_MINIMUM_USDT_BASE_UNITS,
  reconcilePrivateTreasuryVaultObservation,
  startPrivateTreasuryVaultObservationWorker,
} from '../server/private-treasury-vault-observation-worker.mjs'

const vault = { vaultId: 'vault-private-001', treasuryAddress: 'T' + 'A'.repeat(33) }
const now = 1_800_000_000_000
const replayState = {
  trustedKeys: new Map([['test-key', { status: 'active' }]]),
  revokedKeyIds: [],
  seenReceiptIds: [],
  seenObservationIds: [],
  trustRegistryCheckedAtMs: now,
}
const verified = (patch = {}) => ({
  valid: true,
  vaultId: vault.vaultId,
  treasuryAddress: vault.treasuryAddress,
  receiptId: 'receipt-00000001',
  observationId: 'observation-000001',
  reservation: { sequence: 8 },
  assets: { usdt: { availableBaseUnits: '2000000000' } },
  expiresAtMs: now + 30_000,
  limitations: {
    payoutAuthorized: false,
    ledgerMutationPerformed: false,
    signingRequestCreated: false,
    signatureProduced: false,
    transactionSigned: false,
    broadcastAttempted: false,
    mainnetExecutionEnabled: false,
  },
  ...patch,
})
async function run({ verification = verified(), ledger = { lastSequence: '7' }, replay = replayState } = {}) {
  const calls = []
  const result = await reconcilePrivateTreasuryVaultObservation({
    vault,
    nowMs: now,
    readObservation: async () => { calls.push('read-observation'); return { payload: 'signed-receipt' } },
    readReplayState: async () => { calls.push('read-replay-state'); return replay },
    readLedgerState: async () => { calls.push('read-ledger-state'); return ledger },
    verifyObservation: async (_receipt, options) => {
      calls.push('verify')
      assert.equal(options.minimumUsdtBaseUnits, '1000000000')
      return verification
    },
  })
  return { result, calls }
}

test('reconciles a valid next Treasury Vault observation without mutating ledger or authorizing payout', async () => {
  const { result, calls } = await run()
  assert.equal(result.status, 'verified-observation-awaiting-separate-ledger-claim')
  assert.equal(result.sequence, '8')
  assert.equal(result.availableUsdtBaseUnits, '2000000000')
  assert.equal(result.payoutAuthorized, false)
  assert.equal(result.ledgerMutationPerformed, false)
  assert.equal(result.reservationCreated, false)
  assert.equal(result.transactionSigned, false)
  assert.equal(result.broadcastAttempted, false)
  assert.deepEqual(calls.sort(), ['read-observation', 'read-replay-state', 'read-ledger-state', 'verify'].sort())
})

test('retains the hard 1,000 USDT minimum', async () => {
  assert.equal(PRIVATE_TREASURY_VAULT_WORKER_MINIMUM_USDT_BASE_UNITS, '1000000000')
  const { calls } = await run()
  assert.ok(calls.includes('verify'))
})

test('identifies an already-current receipt and rejects stale or replayed sequence', async () => {
  const current = verified()
  const already = await run({
    verification: current,
    ledger: { lastSequence: '8', lastReceiptId: current.receiptId, lastObservationId: current.observationId },
  })
  assert.equal(already.result.status, 'observation-already-current')
  const stale = await run({ verification: verified({ reservation: { sequence: 6 } }) })
  assert.equal(stale.result.status, 'stale-or-replayed-observation')
})

test('holds sequence gaps for manual reconciliation rather than skipping sequence numbers', async () => {
  const { result } = await run({ verification: verified({ reservation: { sequence: 9 } }) })
  assert.equal(result.status, 'observation-sequence-gap')
  assert.equal(result.expectedSequence, '8')
})

test('rejects observations below the verifier boundary or any verifier result that grants authority', async () => {
  const belowMinimum = await run({ verification: { valid: false, reason: 'available-usdt-below-1000-platform-minimum' } })
  assert.equal(belowMinimum.result.status, 'observation-rejected-or-unsafe-verifier-result')
  const unsafe = await run({ verification: verified({ payoutAuthorized: true }) })
  assert.equal(unsafe.result.status, 'observation-rejected-or-unsafe-verifier-result')
})

test('fails closed on incomplete trust/replay state and unavailable read dependencies', async () => {
  const incomplete = await run({ replay: { ...replayState, trustedKeys: {} } })
  assert.equal(incomplete.result.status, 'trust-or-ledger-snapshot-incomplete')
  const unavailable = await reconcilePrivateTreasuryVaultObservation({
    vault,
    readObservation: async () => { throw new Error('offline') },
    readReplayState: async () => replayState,
    readLedgerState: async () => ({ lastSequence: '0' }),
    verifyObservation: async () => verified(),
    nowMs: now,
  })
  assert.equal(unavailable.status, 'read-dependency-unavailable')
})

test('worker is inert by default and only schedules when explicitly enabled', () => {
  let scheduled = 0
  const disabled = startPrivateTreasuryVaultObservationWorker({
    setTimeoutImpl: () => { scheduled += 1; return 1 },
  })
  assert.equal(disabled.started, false)
  assert.equal(scheduled, 0)
  const enabled = startPrivateTreasuryVaultObservationWorker({
    enabled: true,
    sweep: async () => ({}),
    setTimeoutImpl: () => { scheduled += 1; return 2 },
    clearTimeoutImpl: () => {},
    logger: {},
  })
  assert.equal(enabled.started, true)
  assert.equal(scheduled, 1)
  enabled.stop()
})

test('worker source has no sponsor, Fireblocks, Fincra, signing, or broadcast integration', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../server/private-treasury-vault-observation-worker.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /sponsor_direct_payouts|fireblocks|fincra|signMessage|broadcastTransaction/i)
  assert.match(source, /ledgerMutationPerformed: false/)
  assert.match(source, /mainnetExecutionEnabled: false/)
})
