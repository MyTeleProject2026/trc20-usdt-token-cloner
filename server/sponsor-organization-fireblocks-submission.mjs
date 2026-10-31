import {
  classifyFireblocksTransaction,
  createFireblocksClient,
} from './fireblocks-client.mjs'
import {
  preflightSponsorOrganizationFireblocksProvider,
  sponsorFireblocksConfiguration,
} from './sponsor-organization-fireblocks-provider.mjs'

const RELEASE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,159}$/
const OFFICIAL_MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

export function sponsorFireblocksSubmissionRelease(env = process.env) {
  const releaseReference = typeof env.SPONSOR_ORG_FIREBLOCKS_RELEASE_REFERENCE === 'string'
    ? env.SPONSOR_ORG_FIREBLOCKS_RELEASE_REFERENCE.trim() : ''
  const missing = []
  if (env.SPONSOR_ORG_FIREBLOCKS_SUBMISSION_ENABLED !== 'true') missing.push('SPONSOR_ORG_FIREBLOCKS_SUBMISSION_ENABLED=true')
  if (env.SPONSOR_ORG_FIREBLOCKS_PRODUCTION_RELEASE_APPROVED !== 'true') missing.push('SPONSOR_ORG_FIREBLOCKS_PRODUCTION_RELEASE_APPROVED=true')
  if (env.SPONSOR_MAINNET_BUDGET_ACTIVATION_ENABLED !== 'true') missing.push('SPONSOR_MAINNET_BUDGET_ACTIVATION_ENABLED=true')
  if (!RELEASE_REFERENCE.test(releaseReference)) missing.push('SPONSOR_ORG_FIREBLOCKS_RELEASE_REFERENCE')
  return { enabled: missing.length === 0, releaseReference, missing }
}

export function sponsorFireblocksExternalTxId(intent) {
  if (!intent || typeof intent.id !== 'string' || !/^[1-9][0-9]{0,17}$/.test(intent.id)
    || typeof intent.intentDigest !== 'string' || !/^[0-9a-f]{64}$/i.test(intent.intentDigest)) return null
  // Stable for the immutable intent and well within Fireblocks' externalTxId limit.
  return 'tssponsor-' + intent.id + '-' + intent.intentDigest.toLowerCase()
}

function providerStatusView(transaction) {
  const classified = classifyFireblocksTransaction(transaction)
  const status = classified.transactionHash ? 'broadcast-accepted'
    : classified.terminalFailure ? 'provider-failed' : 'provider-pending'
  return {
    status,
    providerTransactionId: typeof transaction?.id === 'string' ? transaction.id : null,
    providerStatus: classified.providerStatus,
    transactionHash: classified.transactionHash,
    terminalProviderFailure: classified.terminalFailure,
  }
}

function safeSubmission(submission, provider = {}) {
  return {
    id: submission.id,
    intentId: submission.intentId,
    externalTxId: submission.externalTxId,
    status: submission.status,
    providerTransactionId: submission.providerTransactionId || provider.providerTransactionId || null,
    providerStatus: submission.providerStatus || provider.providerStatus || null,
    transactionHash: submission.transactionHash || provider.transactionHash || null,
    lastErrorCode: submission.lastErrorCode || null,
    providerObservationCount: submission.providerObservationCount ?? submission.submissionAttempts ?? 0,
    chainVerificationStatus: submission.chainVerificationStatus || 'pending',
    chainVerificationReason: submission.chainVerificationReason || null,
    chainVerificationBlockNumber: submission.chainVerificationBlockNumber || null,
    observedFeeSun: submission.observedFeeSun || null,
    observedEnergyUsage: submission.observedEnergyUsage || null,
    observedNetUsage: submission.observedNetUsage || null,
    principalSettlementStatus: submission.principalSettlementStatus || 'pending',
    feeSettlementStatus: submission.feeSettlementStatus || 'pending-resource-reconciliation',
    chainVerifiedAt: submission.chainVerifiedAt || null,
    createdAt: submission.createdAt,
    updatedAt: submission.updatedAt,
  }
}

function isProviderNotFound(error) {
  return error?.status === 404 || error?.code === 'fireblocks-provider-http-error' && error?.status === 404
}

async function createPrincipalClient(env, dependencies = {}) {
  const config = sponsorFireblocksConfiguration(env)
  if (!config.configured) return { success: false, reason: 'sponsor-fireblocks-provider-not-configured', missing: config.missing }
  const clientOptions = {}
  if (typeof dependencies.fetchImpl === 'function') clientOptions.fetchImpl = dependencies.fetchImpl
  if (typeof dependencies.readSecretFile === 'function') clientOptions.readSecretFile = dependencies.readSecretFile
  const client = (dependencies.fireblocksClientFactory || createFireblocksClient)(config.principalEnv, clientOptions)
  if (client?.isConfigured?.() !== true) return { success: false, reason: 'fireblocks-principal-provider-client-not-configured' }
  return { success: true, client, config }
}

function validIntent(intent) {
  return intent?.status === 'sponsor_authorization_complete'
    && intent.network === 'mainnet'
    && intent.asset === 'USDT'
    && intent.tokenContract === OFFICIAL_MAINNET_USDT
    && typeof intent.receiverAddress === 'string' && /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(intent.receiverAddress)
    && typeof intent.amountBaseUnits === 'string' && /^[1-9][0-9]{0,77}$/.test(intent.amountBaseUnits)
    && typeof intent.feeCapSun === 'string' && /^[1-9][0-9]{0,77}$/.test(intent.feeCapSun)
    && Number.isFinite(Date.parse(intent.expiresAt)) && Date.parse(intent.expiresAt) > Date.now()
    && intent.principalOrganizationId && intent.feeOrganizationId
    && String(intent.principalOrganizationId) === String(intent.feeOrganizationId)
    && intent.principalAccountId && intent.feeAccountId
    && String(intent.principalAccountId) !== String(intent.feeAccountId)
    && intent.principalSponsorAddress !== intent.feeSponsorAddress
}

async function recordProviderResult(store, intent, externalTxId, providerResult, errorCode = null) {
  const status = providerStatusView(providerResult)
  const saved = await store.recordFireblocksPayoutSubmission({
    intentId: intent.id,
    intentDigest: intent.intentDigest,
    externalTxId,
    providerTransactionId: status.providerTransactionId,
    providerStatus: status.providerStatus,
    transactionHash: status.transactionHash,
    status: status.status,
    errorCode,
  })
  if (!saved?.success) return { success: false, reason: saved?.reason || 'fireblocks-submission-state-persistence-failed' }
  return { success: true, submission: saved.submission, provider: status }
}

function responseFor(saved, extra = {}) {
  return {
    success: true,
    status: saved.submission.status,
    submission: safeSubmission(saved.submission, saved.provider),
    providerRequestCreated: Boolean(saved.provider?.providerTransactionId),
    chainSettlement: saved.submission.chainVerificationStatus === 'confirmed'
      ? 'solidified-transfer-verified'
      : saved.submission.chainVerificationStatus === 'failed'
        ? 'solidified-failed-receipt-verified'
        : saved.submission.transactionHash || saved.provider?.transactionHash
          ? 'solidified-chain-verification-required' : 'awaiting-provider-transaction-hash',
    principalSettlementStatus: saved.submission.principalSettlementStatus || 'pending',
    feeSettlementStatus: saved.submission.feeSettlementStatus || 'pending-resource-reconciliation',
    feeReservationRetained: (saved.submission.feeSettlementStatus || 'pending-resource-reconciliation')
      !== 'settled',
    reservationRetained: true,
    canSubmitSponsoredTransfer: false,
    submissionEnabled: false,
    transactionSubmitted: false,
    userFundedFallbackAllowed: false,
    note: 'Fireblocks provider status is not proof of a solidified TRON transfer. The sponsor reservations remain active until independent chain reconciliation and budget settlement.',
    ...extra,
  }
}

/**
 * Creates a Fireblocks transaction request only after explicit backend release
 * gates, exact dual-sponsor approvals, current registry scope, dual-budget
 * reservations, TRON resource preflight and Fireblocks custody preflight pass.
 * Fireblocks externalTxId is deterministic and permanent, so a retry after an
 * ambiguous timeout first looks up the same ID and cannot create a second payout.
 */
export async function submitSponsorOrganizationFireblocksPayout({
  store,
  intentId,
  env = process.env,
  custodyPreflight = preflightSponsorOrganizationFireblocksProvider,
  fireblocksClientFactory = createFireblocksClient,
  fetchImpl,
  readSecretFile,
  tronWebFactory,
  chainPreflight,
  timeoutMs,
} = {}) {
  const fail = (reason, extra = {}) => ({
    success: false, reason, status: reason, canSubmitSponsoredTransfer: false,
    submissionEnabled: false, transactionSubmitted: false, userFundedFallbackAllowed: false, ...extra,
  })
  if (!store || typeof store.getPayoutIntentForPreflight !== 'function'
    || typeof store.prepareFireblocksPayoutSubmission !== 'function'
    || typeof store.recordFireblocksPayoutSubmission !== 'function'
    || typeof intentId !== 'string' || !/^[1-9][0-9]{0,17}$/.test(intentId)) {
    return fail('invalid-fireblocks-submission-request')
  }
  const release = sponsorFireblocksSubmissionRelease(env)
  if (!release.enabled) return fail('sponsor-fireblocks-production-release-disabled', { missing: release.missing })

  let loaded
  try { loaded = await store.getPayoutIntentForPreflight(intentId) } catch {
    return fail('sponsor-payout-intent-read-unavailable')
  }
  if (!loaded?.success || !validIntent(loaded.intent)
    || loaded.sponsorOwnerApprovalsVerified !== true) {
    return fail('dual-approved-official-mainnet-usdt-intent-required')
  }
  const intent = loaded.intent
  const externalTxId = sponsorFireblocksExternalTxId(intent)
  if (!externalTxId) return fail('fireblocks-external-transaction-id-unavailable')

  const provider = await createPrincipalClient(env, { fireblocksClientFactory, fetchImpl, readSecretFile })
  if (!provider.success) return fail(provider.reason, { missing: provider.missing || [] })
  const { client } = provider

  // Always recover an existing provider request before evaluating whether a new
  // transaction can be created. Provider-side externalTxId is permanently unique.
  let existing = null
  try { existing = await client.findTransactionByExternalId(externalTxId) } catch (error) {
    if (!isProviderNotFound(error)) return fail('fireblocks-existing-transaction-lookup-unavailable')
  }
  if (existing) {
    const prepared = await store.prepareFireblocksPayoutSubmission({
      intentId, intentDigest: intent.intentDigest, externalTxId, releaseReference: release.releaseReference,
    })
    if (!prepared?.success) return fail(prepared?.reason || 'fireblocks-submission-record-unavailable')
    const saved = await recordProviderResult(store, intent, externalTxId, existing)
    if (!saved.success) return fail(saved.reason)
    return responseFor(saved)
  }

  let custody
  try {
    custody = await custodyPreflight({
      store, intentId, env, fireblocksClientFactory, fetchImpl, readSecretFile, tronWebFactory,
      chainPreflight, timeoutMs,
    })
  } catch {
    return fail('fireblocks-custody-preflight-unavailable')
  }
  if (custody?.success !== true || custody.status !== 'fireblocks-custody-preflight-passed-review-required') {
    return fail('fireblocks-custody-preflight-not-passed', { custodyPreflightStatus: custody?.status || custody?.reason || 'unknown' })
  }

  const prepared = await store.prepareFireblocksPayoutSubmission({
    intentId, intentDigest: intent.intentDigest, externalTxId, releaseReference: release.releaseReference,
  })
  if (!prepared?.success) return fail(prepared?.reason || 'fireblocks-submission-record-unavailable')

  // Re-read after the database claim to close the lookup/claim race. If another
  // request created this permanent externalTxId first, only attach to that request.
  try { existing = await client.findTransactionByExternalId(externalTxId) } catch (error) {
    if (!isProviderNotFound(error)) {
      return fail('fireblocks-existing-transaction-lookup-unavailable', {
        submission: safeSubmission(prepared.submission), reservationRetained: true,
      })
    }
  }
  if (existing) {
    const saved = await recordProviderResult(store, intent, externalTxId, existing)
    if (!saved.success) return fail(saved.reason)
    return responseFor(saved)
  }

  const amountUsdt = decimalFromBaseUnits(intent.amountBaseUnits)
  if (!amountUsdt) return fail('invalid-six-decimal-usdt-amount')
  let transaction
  try {
    transaction = await client.createUsdtTransfer({
      recipientAddress: intent.receiverAddress,
      amountUsdt,
      externalTxId,
      note: 'TRON Token Studio sponsor payout intent ' + intent.id,
    })
  } catch {
    // A provider/network timeout may occur after Fireblocks accepted the request.
    // Never release reservations or issue a new external ID; look up the same ID.
    try { transaction = await client.findTransactionByExternalId(externalTxId) } catch {
      const unknown = await store.recordFireblocksPayoutSubmission({
        intentId, intentDigest: intent.intentDigest, externalTxId,
        status: 'provider-unknown', errorCode: 'fireblocks-provider-outcome-unknown',
      })
      return fail('fireblocks-provider-outcome-unknown', {
        submission: unknown?.success ? safeSubmission(unknown.submission) : safeSubmission(prepared.submission),
        reservationRetained: true,
        recovery: 'Retry status lookup with the same deterministic externalTxId. Do not create a new payout or release the reservation.',
      })
    }
    if (!transaction) {
      const unknown = await store.recordFireblocksPayoutSubmission({
        intentId, intentDigest: intent.intentDigest, externalTxId,
        status: 'provider-unknown', errorCode: 'fireblocks-provider-outcome-unknown',
      })
      return fail('fireblocks-provider-outcome-unknown', {
        submission: unknown?.success ? safeSubmission(unknown.submission) : safeSubmission(prepared.submission),
        reservationRetained: true,
      })
    }
  }

  const saved = await recordProviderResult(store, intent, externalTxId, transaction)
  if (!saved.success) return fail(saved.reason, { providerRequestMayExist: true, externalTxId, reservationRetained: true })
  return responseFor(saved)
}

function decimalFromBaseUnits(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,77}$/.test(value)) return null
  const units = BigInt(value)
  const whole = units / 1_000_000n
  const fraction = (units % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return fraction ? whole.toString() + '.' + fraction : whole.toString()
}

/** Polls only an already-created Fireblocks request; it never creates a transfer. */
export async function refreshSponsorOrganizationFireblocksPayout({
  store, intentId, env = process.env, fireblocksClientFactory = createFireblocksClient, fetchImpl, readSecretFile,
} = {}) {
  const fail = (reason) => ({
    success: false, reason, status: reason, canSubmitSponsoredTransfer: false,
    submissionEnabled: false, transactionSubmitted: false, userFundedFallbackAllowed: false,
  })
  if (!store || typeof store.getFireblocksPayoutSubmission !== 'function'
    || typeof store.getPayoutIntentForPreflight !== 'function'
    || typeof store.recordFireblocksPayoutSubmission !== 'function') return fail('fireblocks-submission-store-unavailable')
  if (typeof intentId !== 'string' || !/^[1-9][0-9]{0,17}$/.test(intentId)) return fail('invalid-fireblocks-submission-id')
  const current = await store.getFireblocksPayoutSubmission(intentId)
  if (!current?.success) return fail(current?.reason || 'fireblocks-submission-not-found')
  if (current.submission.intentId !== intentId
    || typeof current.submission.intentDigest !== 'string'
    || !/^[0-9a-f]{64}$/i.test(current.submission.intentDigest)
    || current.submission.externalTxId !== 'tssponsor-' + intentId + '-' + current.submission.intentDigest.toLowerCase()) {
    return fail('payout-intent-no-longer-matches-provider-submission')
  }
  // Status refresh remains available after the original 10-minute intent expiry.
  // A provider submission keeps its budget reservations active for recovery.
  const intent = { id: intentId, intentDigest: current.submission.intentDigest }
  const externalTxId = current.submission.externalTxId
  const provider = await createPrincipalClient(env, { fireblocksClientFactory, fetchImpl, readSecretFile })
  if (!provider.success) return fail(provider.reason)
  let transaction
  try {
    transaction = current.submission.providerTransactionId
      ? await provider.client.getTransaction(current.submission.providerTransactionId)
      : await provider.client.findTransactionByExternalId(externalTxId)
  } catch (error) {
    if (isProviderNotFound(error)) return {
      success: true, status: current.submission.status, submission: safeSubmission(current.submission),
      providerRequestCreated: false, reservationRetained: true,
      canSubmitSponsoredTransfer: false, submissionEnabled: false, transactionSubmitted: false,
      note: 'Fireblocks has not returned a matching transaction. Do not infer a chain transfer; keep the reservation and retry status lookup.',
    }
    return fail('fireblocks-provider-status-unavailable')
  }
  if (!transaction || typeof transaction !== 'object') return fail('invalid-fireblocks-transaction-response')
  const saved = await recordProviderResult(store, intent, externalTxId, transaction)
  if (!saved.success) return fail(saved.reason)
  return responseFor(saved)
}

export default submitSponsorOrganizationFireblocksPayout