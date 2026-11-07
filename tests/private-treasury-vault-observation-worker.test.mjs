import test from 'node:test'
import assert from 'node:assert/strict'
import { createPrivateTreasuryVaultReadOnlyObservationReader } from '../server/private-treasury-vault-observation.mjs'
import {
  PRIVATE_TREASURY_VAULT_WORKER_MINIMUM_USDT_BASE_UNITS,
  reconcilePrivateTreasuryVaultObservation,
  startPrivateTreasuryVaultObservationWorker,
  reconcilePrivateTreasuryVaultObservationFromPostgres,
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
    sourceObservationCryptographicallyAttested: true,
    chainBlockIndependentlyQueriedByThisVerifier: false,
    vaultOwnershipVerified: false,
    signerAuthorityVerified: false,
    creditFacilityVerified: false,
    payoutAuthorized: false,
    ledgerMutationPerformed: false,
    reservationCreated: false,
    providerContactedByVerifier: false,
    signingRequestCreated: false,
    signatureProduced: false,
    transactionSigned: false,
    broadcastAttempted: false,
    mainnetExecutionEnabled: false,
  },
  ...patch,
})

function readOnlyReader({ onRead = () => {}, fail = false, receipt = {
  payload: 'signed-receipt',
  signature: { algorithm: 'Ed25519', keyId: 'test-key', value: 'A'.repeat(86) },
} } = {}) {
  return createPrivateTreasuryVaultReadOnlyObservationReader({
    gatewayBaseUrl: 'https://vault.example',
    allowedOrigins: ['https://vault.example'],
    bearerToken: 'test-token-value-long-enough',
    fetchImpl: async (_url, options) => {
      assert.equal(options.method, 'GET')
      assert.equal(options.redirect, 'error')
      onRead()
      if (fail) throw new Error('offline')
      return { ok: true, headers: { get: () => null }, text: async () => JSON.stringify(receipt) }
    },
  })
}

async function run({ verification = verified(), ledger = { lastSequence: '7' }, replay = replayState } = {}) {
  const calls = []
  const result = await reconcilePrivateTreasuryVaultObservation({
    vault,
    nowMs: now,
    readObservation: readOnlyReader({ onRead: () => calls.push('read-observation') }),
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
    readObservation: readOnlyReader({ fail: true }),
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


test('integrates one coherent PostgreSQL snapshot with the observation verifier read-only', async () => {
  let snapshotReads = 0
  let observationReads = 0
  let verificationOptions
  const snapshot = {
    success: true,
    vault: {
      vaultId: 'vault-private-001',
      network: 'mainnet',
      asset: 'USDT',
      tokenContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      decimals: 6,
      treasuryAddress: vault.treasuryAddress,
      active: true,
    },
    replayState,
    ledgerState: { lastSequence: '7', lastReceiptId: null, lastObservationId: null },
  }
  const repository = {
    async readSnapshot(id, trustSnapshot) {
      snapshotReads += 1
      assert.equal(id, vault.vaultId)
      assert.equal(trustSnapshot, configuredTrust)
      return snapshot
    },
  }
  const configuredTrust = { configured: true, trustedKeys: replayState.trustedKeys, revokedKeyIds: [], checkedAtMs: now }
  const result = await reconcilePrivateTreasuryVaultObservationFromPostgres({
    repository,
    trustSnapshot: configuredTrust,
    vaultId: vault.vaultId,
    expectedIssuer: 'financial-vault.example',
    readObservation: readOnlyReader({ onRead: () => { observationReads += 1 } }),
    verifyObservation: async (_receipt, options) => {
      verificationOptions = options
      return verified()
    },
    nowMs: now,
  })
  assert.equal(result.status, 'verified-observation-awaiting-separate-ledger-claim')
  assert.equal(snapshotReads, 1)
  assert.equal(observationReads, 1)
  assert.equal(verificationOptions.expectedIssuer, 'financial-vault.example')
  assert.equal(verificationOptions.expectedAudience, 'tron-transfer-private-treasury')
  assert.equal(verificationOptions.minimumUsdtBaseUnits, '1000000000')
  assert.equal(result.ledgerMutationPerformed, false)
  assert.equal(result.reservationCreated, false)
  assert.equal(result.payoutAuthorized, false)
  assert.equal(result.transactionSigned, false)
  assert.equal(result.broadcastAttempted, false)
})

test('PostgreSQL adapter fails closed for inactive or incorrectly bound vaults', async () => {
  const base = {
    success: true,
    vault: {
      vaultId: 'vault-private-001', network: 'mainnet', asset: 'USDT',
      tokenContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6,
      treasuryAddress: vault.treasuryAddress, active: false,
    },
    replayState, ledgerState: { lastSequence: '0' },
  }
  const result = await reconcilePrivateTreasuryVaultObservationFromPostgres({
    repository: { readSnapshot: async () => base },
    trustSnapshot: { configured: true },
    vaultId: vault.vaultId,
    expectedIssuer: 'financial-vault.example',
    readObservation: readOnlyReader(),
    verifyObservation: async () => verified(),
    nowMs: now,
  })
  assert.equal(result.status, 'vault-configuration-unsupported')
})

test('PostgreSQL adapter requires a configured expected issuer and repository', async () => {
  const result = await reconcilePrivateTreasuryVaultObservationFromPostgres({})
  assert.equal(result.status, 'worker-configuration-invalid')
})

test('rejects arbitrary observation callbacks that are not created by the read-only GET reader', async () => {
  let called = false
  const result = await reconcilePrivateTreasuryVaultObservation({
    vault,
    readObservation: async () => { called = true; return { readOnly: true, receipt: {} } },
    readReplayState: async () => replayState,
    readLedgerState: async () => ({ lastSequence: '0' }),
    verifyObservation: async () => verified(),
    nowMs: now,
  })
  assert.equal(result.status, 'worker-configuration-invalid')
  assert.equal(called, false)
})

test('read-only observation reader rejects an incomplete receipt envelope before worker verification', async () => {
  const reader = readOnlyReader({ receipt: { payload: 'receipt' } })
  await assert.rejects(reader(vault), /private-vault-observation-envelope-invalid/)
})

test('rejects verifier results that omit cryptographic-attestation or reservation limitations', async () => {
  const missingAttestation = await run({
    verification: verified({ limitations: { ...verified().limitations, sourceObservationCryptographicallyAttested: false } }),
  })
  assert.equal(missingAttestation.result.status, 'observation-rejected-or-unsafe-verifier-result')
  const missingReservationBoundary = await run({
    verification: verified({ limitations: { ...verified().limitations, reservationCreated: true } }),
  })
  assert.equal(missingReservationBoundary.result.status, 'observation-rejected-or-unsafe-verifier-result')
})
