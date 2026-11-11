import { isPrivateTreasuryVaultReadOnlyObservationReader } from './private-treasury-vault-observation.mjs'

/**
 * Provider-independent, read-only Treasury Vault observation reconciler.
 *
 * This worker compares a verified signed observation with caller-supplied
 * read-only ledger/replay snapshots. It never claims an observation, writes a
 * ledger, creates a reservation, authorizes a payout, signs, or broadcasts.
 * It is deliberately not wired into application startup.
 */

export const PRIVATE_TREASURY_VAULT_WORKER_MINIMUM_USDT_BASE_UNITS = '1000000000'
export const PRIVATE_TREASURY_VAULT_WORKER_DEFAULT_INTERVAL_MS = 45_000

function safeSequence(value) {
  const text = String(value ?? '')
  if (!/^(0|[1-9][0-9]{0,18})$/.test(text)) return null
  const sequence = BigInt(text)
  return sequence <= 9223372036854775807n ? sequence : null
}

function result(status, details = {}) {
  return Object.freeze({
    status,
    payoutAuthorized: false,
    ledgerMutationPerformed: false,
    reservationCreated: false,
    signingRequestCreated: false,
    signatureProduced: false,
    transactionSigned: false,
    broadcastAttempted: false,
    mainnetExecutionEnabled: false,
    ...details,
  })
}

/**
 * Perform one read-only comparison for a configured vault.
 *
 * Dependencies are explicit so tests can supply deterministic fixtures. A
 * production caller must supply a separately trusted financial-vault trust
 * snapshot and read-only sources; this module does not read environment
 * variables, import a provider SDK, or configure credentials.
 */
export async function reconcilePrivateTreasuryVaultObservation({
  vault,
  readObservation,
  readReplayState,
  readLedgerState,
  verifyObservation,
  nowMs = Date.now(),
} = {}) {
  if (!vault || typeof vault.vaultId !== 'string' || !vault.vaultId.trim()
    || typeof vault.treasuryAddress !== 'string' || !vault.treasuryAddress.trim()
    || !isPrivateTreasuryVaultReadOnlyObservationReader(readObservation)
    || typeof readReplayState !== 'function'
    || typeof readLedgerState !== 'function'
    || typeof verifyObservation !== 'function'
    || !Number.isSafeInteger(nowMs) || nowMs <= 0) {
    return result('worker-configuration-invalid')
  }

  let observationEnvelope
  let replayState
  let ledgerState
  try {
    [observationEnvelope, replayState, ledgerState] = await Promise.all([
      readObservation(vault),
      readReplayState(vault.vaultId),
      readLedgerState(vault.vaultId),
    ])
  } catch {
    return result('read-dependency-unavailable')
  }

  if (!observationEnvelope || observationEnvelope.readOnly !== true || !observationEnvelope.receipt) {
    return result('read-only-observation-reader-contract-invalid')
  }
  const receipt = observationEnvelope.receipt

  if (!receipt || !replayState || !ledgerState
    || !Array.isArray(replayState.seenReceiptIds)
    || !Array.isArray(replayState.seenObservationIds)
    || !Array.isArray(replayState.revokedKeyIds)
    || !(replayState.trustedKeys instanceof Map)
    || !Number.isSafeInteger(replayState.trustRegistryCheckedAtMs)) {
    return result('trust-or-ledger-snapshot-incomplete')
  }

  let verified
  try {
    verified = await verifyObservation(receipt, {
      ...replayState,
      expectedIssuer: vault.expectedIssuer,
      expectedAudience: vault.expectedAudience || 'tron-transfer-private-treasury',
      expectedVaultId: vault.vaultId,
      expectedTreasuryAddress: vault.treasuryAddress,
      minimumUsdtBaseUnits: PRIVATE_TREASURY_VAULT_WORKER_MINIMUM_USDT_BASE_UNITS,
      nowMs,
    })
  } catch {
    return result('observation-verification-failed')
  }

  if (!verified || verified.valid !== true
    || verified.payoutAuthorized === true
    || verified.limitations?.sourceObservationCryptographicallyAttested !== true
    || verified.limitations?.chainBlockIndependentlyQueriedByThisVerifier !== false
    || verified.limitations?.vaultOwnershipVerified !== false
    || verified.limitations?.signerAuthorityVerified !== false
    || verified.limitations?.creditFacilityVerified !== false
    || verified.limitations?.payoutAuthorized !== false
    || verified.limitations?.ledgerMutationPerformed !== false
    || verified.limitations?.reservationCreated !== false
    || verified.limitations?.providerContactedByVerifier !== false
    || verified.limitations?.signingRequestCreated !== false
    || verified.limitations?.signatureProduced !== false
    || verified.limitations?.transactionSigned !== false
    || verified.limitations?.broadcastAttempted !== false
    || verified.limitations?.mainnetExecutionEnabled !== false) {
    return result('observation-rejected-or-unsafe-verifier-result', {
      reason: verified?.reason || 'verified-read-only-observation-required',
    })
  }

  const incomingSequence = safeSequence(verified.reservation?.sequence)
  const currentSequence = safeSequence(ledgerState.lastSequence)
  if (incomingSequence === null || currentSequence === null) {
    return result('ledger-sequence-invalid')
  }

  const receiptId = verified.receiptId
  const observationId = verified.observationId
  if (typeof receiptId !== 'string' || !receiptId
    || typeof observationId !== 'string' || !observationId
    || verified.vaultId !== vault.vaultId
    || verified.treasuryAddress !== vault.treasuryAddress) {
    return result('verified-observation-binding-invalid')
  }

  if (incomingSequence === currentSequence
    && ledgerState.lastReceiptId === receiptId
    && ledgerState.lastObservationId === observationId) {
    return result('observation-already-current', {
      vaultId: vault.vaultId,
      sequence: incomingSequence.toString(),
      receiptId,
      observationId,
    })
  }

  if (incomingSequence <= currentSequence) {
    return result('stale-or-replayed-observation', {
      vaultId: vault.vaultId,
      incomingSequence: incomingSequence.toString(),
      currentSequence: currentSequence.toString(),
    })
  }

  if (incomingSequence !== currentSequence + 1n) {
    return result('observation-sequence-gap', {
      vaultId: vault.vaultId,
      incomingSequence: incomingSequence.toString(),
      expectedSequence: (currentSequence + 1n).toString(),
    })
  }

  return result('verified-observation-awaiting-separate-ledger-claim', {
    vaultId: vault.vaultId,
    sequence: incomingSequence.toString(),
    receiptId,
    observationId,
    availableUsdtBaseUnits: verified.assets?.usdt?.availableBaseUnits ?? null,
    observationExpiresAtMs: verified.expiresAtMs ?? null,
    note: 'A verified observation is not a reservation, proof of spend authority, or payout authorization.',
  })
}

/**
 * Bounded, non-overlapping scheduler. Disabled unless explicitly enabled by a
 * future caller. This module is not started by server/index.mjs.
 */
export function startPrivateTreasuryVaultObservationWorker({
  enabled = false,
  intervalMs = PRIVATE_TREASURY_VAULT_WORKER_DEFAULT_INTERVAL_MS,
  sweep,
  logger = console,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (enabled !== true) return { started: false, reason: 'not-explicitly-enabled', stop() {} }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 15_000 || intervalMs > 300_000
    || typeof sweep !== 'function' || typeof setTimeoutImpl !== 'function'
    || typeof clearTimeoutImpl !== 'function') {
    return { started: false, reason: 'worker-configuration-invalid', stop() {} }
  }

  let stopped = false
  let running = false
  let timer = null
  const schedule = (delay) => {
    if (stopped) return
    timer = setTimeoutImpl(run, delay)
    timer?.unref?.()
  }
  const run = async () => {
    if (stopped || running) return
    running = true
    try {
      const summary = await sweep()
      logger.info?.('Private Treasury Vault read-only observation sweep:', JSON.stringify(summary))
    } catch {
      logger.error?.('Private Treasury Vault read-only observation sweep failed.')
    } finally {
      running = false
      schedule(intervalMs)
    }
  }
  schedule(10_000)
  return {
    started: true,
    intervalMs,
    stop() {
      stopped = true
      if (timer !== null) clearTimeoutImpl(timer)
    },
  }
}


/**
 * Reconcile through one PostgreSQL repeatable-read snapshot. The repository
 * interface is read-only; the observation fetcher must also be read-only.
 * This adapter deliberately does not connect to the ledger writer or startup.
 */
export async function reconcilePrivateTreasuryVaultObservationFromPostgres({
  repository,
  trustSnapshot,
  vaultId,
  expectedIssuer,
  expectedAudience = 'tron-transfer-private-treasury',
  readObservation,
  verifyObservation,
  nowMs = Date.now(),
} = {}) {
  if (!repository || typeof repository.readSnapshot !== 'function'
    || typeof vaultId !== 'string' || !vaultId.trim()
    || typeof expectedIssuer !== 'string' || !expectedIssuer.trim()
    || !isPrivateTreasuryVaultReadOnlyObservationReader(readObservation)
    || typeof verifyObservation !== 'function'
    || !Number.isSafeInteger(nowMs) || nowMs <= 0) {
    return result('worker-configuration-invalid')
  }

  let snapshot
  try {
    snapshot = await repository.readSnapshot(vaultId, trustSnapshot)
  } catch {
    return result('read-dependency-unavailable')
  }
  if (!snapshot || snapshot.success !== true) {
    return result('read-dependency-unavailable', {
      reason: snapshot?.reason || 'treasury-vault-snapshot-unavailable',
    })
  }

  const storedVault = snapshot.vault
  if (!storedVault || storedVault.vaultId !== vaultId
    || storedVault.network !== 'mainnet'
    || storedVault.asset !== 'USDT'
    || storedVault.tokenContract !== 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
    || storedVault.decimals !== 6
    || storedVault.active !== true
    || typeof storedVault.treasuryAddress !== 'string'
    || !storedVault.treasuryAddress.trim()) {
    return result('vault-configuration-unsupported')
  }

  return reconcilePrivateTreasuryVaultObservation({
    vault: {
      vaultId: storedVault.vaultId,
      treasuryAddress: storedVault.treasuryAddress,
      expectedIssuer,
      expectedAudience,
    },
    readObservation,
    readReplayState: async () => snapshot.replayState,
    readLedgerState: async () => snapshot.ledgerState,
    verifyObservation,
    nowMs,
  })
}
