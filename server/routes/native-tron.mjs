import { recordNativeTransferVerification, recordSponsorResourceDelegation, listSponsorResourceDelegations, listPersistedReceiverHistory, registerTrackedWallet, listSponsorBudgets, listSponsorTransfers, reserveSponsorTransfer, createSponsorBudgetDraft, pauseSponsorBudget, getSponsorBudgetById, activateSponsorBudget, isSponsorAgreementReferenceConfigured, isApprovedSponsorAgreementScope, createSponsorProviderApplication, getSponsorProviderApplicationStatus, listSponsorProviderApplications, reviewSponsorProviderApplication } from '../database.mjs'
import { timingSafeEqual, createHash, randomUUID } from 'node:crypto'
import { getSponsorshipStatus } from '../sponsorship-status.mjs'
import { createSponsorFundingReader } from '../sponsor-funding.mjs'
import { createSponsorRoleFundingReader } from '../sponsor-roles.mjs'
import { createSponsorResourceReader } from '../sponsor-resources.mjs'
import { createSponsorResourceDelegationVerifier } from '../sponsor-resource-delegation-verifier.mjs'
import { reconcileSponsorBudgets } from '../sponsor-reconciliation.mjs'

import { Router } from 'express'

const router = Router()
const txPattern = /^[0-9a-fA-F]{64}$/
const networks = {
  shasta: 'https://api.shasta.trongrid.io',
  nile: 'https://nile.trongrid.io',
  mainnet: 'https://api.trongrid.io',
}
const addressPattern = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const providerApplicationScopes = new Set(['network-fees', 'trx-grant', 'trc20-grant'])
const providerApplicationRateLimit = new Map()

function reserveProviderApplicationAttempt(normalizedEmail) {
  const now = Date.now()
  const key = createHash('sha256').update(normalizedEmail, 'utf8').digest('hex')
  const recent = (providerApplicationRateLimit.get(key) || []).filter((timestamp) => now - timestamp < 60 * 60 * 1000)
  if (recent.length >= 3) {
    providerApplicationRateLimit.set(key, recent)
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((60 * 60 * 1000 - (now - recent[0])) / 1000)) }
  }
  recent.push(now)
  providerApplicationRateLimit.set(key, recent)
  if (providerApplicationRateLimit.size > 2000) {
    // Remove expired buckets first. If the map is still too large after a
    // high-cardinality burst, evict oldest entries to keep process memory bounded.
    for (const [candidate, timestamps] of providerApplicationRateLimit) {
      if (!timestamps.some((timestamp) => now - timestamp < 60 * 60 * 1000)) providerApplicationRateLimit.delete(candidate)
      if (providerApplicationRateLimit.size <= 1800) break
    }
    while (providerApplicationRateLimit.size > 2000) {
      const oldestKey = providerApplicationRateLimit.keys().next().value
      if (oldestKey === undefined) break
      providerApplicationRateLimit.delete(oldestKey)
    }
  }
  return { allowed: true, key, timestamp: now }
}

function releaseProviderApplicationAttempt(attempt) {
  if (!attempt?.allowed || !attempt.key) return
  const timestamps = providerApplicationRateLimit.get(attempt.key) || []
  const updated = timestamps.filter((timestamp) => timestamp !== attempt.timestamp)
  if (updated.length) providerApplicationRateLimit.set(attempt.key, updated)
  else providerApplicationRateLimit.delete(attempt.key)
}

// Read-only sponsorship capability status. This API deliberately fails closed:
// provider onboarding, signer authorization, limits, and fee/asset reconciliation
// are not yet complete, so environment variables cannot accidentally enable sends.
router.get('/sponsorship/status', (_req, res) => {
  return res.json({
    success: true,
    sponsorship: getSponsorshipStatus(),
    limitations: [
      'This endpoint reports capability status only; it never authorizes or submits a transfer.',
      'An on-chain confirmation does not guarantee an exchange will credit a deposit.',
    ],
  })
})

// Read-only, network-scoped snapshot of the sponsor account's actual chain balances.
// This never grants transfer authority and never converts balance visibility into budget approval.
const readSponsorFundingStatus = createSponsorFundingReader()
router.get('/sponsorship/funding-status', async (req, res) => {
  res.setHeader?.('Cache-Control', 'no-store')
  res.setHeader?.('Pragma', 'no-cache')

  const network = req.query?.network
  const refreshValue = req.query?.refresh
  if (refreshValue !== undefined && refreshValue !== '1' && refreshValue !== '0') {
    return res.status(400).json({ success: false, error: 'invalid-refresh', message: 'refresh must be 1 or 0.' })
  }
  if (typeof network !== 'string' || !Object.hasOwn(networks, network)) {
    return res.status(400).json({
      success: false,
      error: 'invalid-network',
      message: 'network must be mainnet, shasta, or nile.',
    })
  }
  try {
    const funding = await readSponsorFundingStatus(network, { refresh: refreshValue === '1' })
    const verifiedRead = funding?.onChainBalanceRead === true
    return res.status(verifiedRead ? 200 : 503).json({
      success: verifiedRead,
      funding,
      limitations: [
        'This endpoint reads chain balances only. It does not verify sponsor consent, a spendable off-chain budget, signer authorization, or permission to submit.',
        'Configured budget amounts and actual chain balances are different measurements; neither is receiver credit.',
        'No transfer is signed, submitted, broadcast, or charged to user funds by this endpoint.',
      ],
    })
  } catch {
    return res.status(502).json({
      success: false,
      error: 'sponsor-balance-read-failed',
      message: 'Could not read the sponsor balance from the selected network.',
    })
  }
})

// Read-only status for independent fee and asset-principal sponsor accounts.
const readSponsorRoleFunding = createSponsorRoleFundingReader()
router.get('/sponsorship/roles', async (req, res) => {
  res.setHeader?.('Cache-Control', 'no-store')
  res.setHeader?.('Pragma', 'no-cache')
  const network = req.query?.network
  const refreshValue = req.query?.refresh
  if (refreshValue !== undefined && refreshValue !== '0' && refreshValue !== '1') {
    return res.status(400).json({ success: false, error: 'invalid-refresh', message: 'refresh must be 0 or 1.' })
  }
  if (typeof network !== 'string' || !Object.hasOwn(networks, network)) {
    return res.status(400).json({ success: false, error: 'invalid-network', message: 'network must be mainnet, shasta, or nile.' })
  }
  try {
    // A 200 response means diagnostics were returned, not that either sponsor is enabled.
    const result = await readSponsorRoleFunding(network, { refresh: refreshValue === '1' })
    if (result.success !== true) return res.status(503).json(result)
    const { fundingSnapshots: _fundingSnapshots, ...publicResult } = result
    return res.status(200).json(publicResult)
  } catch {
    return res.status(503).json({
      success: false,
      error: 'sponsor-role-status-unavailable',
      roles: {},
      canSubmitSponsoredTransfer: false,
      submissionEnabled: false,
      message: 'Could not read both sponsor roles. No transfer was authorized or submitted.',
    })
  }
})

// Protected read-only reconciliation for the independent fee and asset sponsors.
// Each sponsor is reconciled only against budget rows for its exact address.
router.get('/sponsorship/roles/reconciliation', async (req, res) => {
  res.setHeader?.('Cache-Control', 'no-store')
  res.setHeader?.('Pragma', 'no-cache')
  res.setHeader?.('Vary', 'Authorization')
  if (typeof process.env.SPONSOR_ADMIN_API_TOKEN !== 'string'
    || process.env.SPONSOR_ADMIN_API_TOKEN.length < 32) {
    return res.status(503).json({ success: false, error: 'sponsor-admin-not-configured', canSubmitSponsoredTransfer: false, submissionEnabled: false })
  }
  if (!hasValidSponsorAdminToken(req)) {
    return res.status(401).json({ success: false, error: 'unauthorized', canSubmitSponsoredTransfer: false, submissionEnabled: false })
  }
  const network = req.query?.network
  if (typeof network !== 'string' || !Object.hasOwn(networks, network)) {
    return res.status(400).json({ success: false, error: 'invalid-network', message: 'network must be mainnet, shasta, or nile.', canSubmitSponsoredTransfer: false })
  }

  try {
    // Reuse a very recent successful snapshot instead of forcing a second read
    // milliseconds after the public diagnostics panel just read it. The pure
    // reconciler independently rejects cached snapshots older than 10 seconds.
    const roleResult = await readSponsorRoleFunding(network, { refresh: false })
    if (roleResult?.success !== true || !roleResult.fundingSnapshots) {
      return res.status(503).json({
        success: false, error: 'sponsor-role-status-unavailable',
        canSubmitSponsoredTransfer: false, submissionEnabled: false,
      })
    }
    if (roleResult.accountsConfigured !== true) {
      return res.status(503).json({
        success: false,
        error: 'sponsor-role-addresses-missing',
        accountsConfigured: false,
        message: 'Configure both role-specific sponsor addresses before reconciling their separate ledgers.',
        canSubmitSponsoredTransfer: false, submissionEnabled: false,
      })
    }
    if (roleResult.configuredAddressesDistinct !== true) {
      return res.status(409).json({
        success: false,
        error: 'sponsor-role-addresses-not-distinct',
        configuredAddressesDistinct: false,
        message: 'The fee sponsor and asset-principal sponsor must have distinct addresses for separate reconciliation. No grouped totals were calculated.',
        canSubmitSponsoredTransfer: false, submissionEnabled: false,
      })
    }

    const scopes = [
      { role: 'network-fee-sponsor', snapshot: roleResult.fundingSnapshots.networkFeeSponsor },
      { role: 'asset-principal-sponsor', snapshot: roleResult.fundingSnapshots.assetPrincipalSponsor },
    ]
    const roles = await Promise.all(scopes.map(async ({ role, snapshot }) => {
      if (snapshot?.onChainBalanceRead !== true
        || !['fresh', 'cached'].includes(snapshot?.cache?.status)
        || snapshot.network !== network || typeof snapshot.sponsorAddress !== 'string') {
        return {
          role,
          success: false,
          status: snapshot?.cache?.status === 'refresh-throttled'
            ? 'fresh-snapshot-required-refresh-throttled' : 'fresh-solidified-snapshot-required',
          reconciliation: null,
          budgetCount: null,
          canSubmitSponsoredTransfer: false,
        }
      }
      const ledger = await listSponsorBudgets({ network, sponsorAddress: snapshot.sponsorAddress, limit: 100 })
      if (ledger?.success !== true) {
        return {
          role, success: false, status: ledger?.reason || 'sponsor-ledger-unavailable',
          reconciliation: null, budgetCount: null, canSubmitSponsoredTransfer: false,
        }
      }
      if (ledger.budgets.length >= 100) {
        return {
          role, success: false, status: 'sponsor-ledger-truncated',
          reconciliation: null, budgetCount: ledger.budgets.length, canSubmitSponsoredTransfer: false,
        }
      }
      const budgets = ledger.budgets.map((budget) => ({
        ...budget,
        approvalScopeVerified: budget.status === 'active'
          && typeof budget.review_reference === 'string'
          && budget.review_reference.length > 0
          && budget.approved_at != null
          && isApprovedSponsorAgreementScope({ consentReference: budget.approval_reference, budget }),
      }))
      const reconciliation = reconcileSponsorBudgets({ network, fundingSnapshot: snapshot, budgets })
      return {
        role,
        success: reconciliation.success === true,
        status: reconciliation.status,
        budgetCount: reconciliation.budgetCount,
        reconciliation,
        canSubmitSponsoredTransfer: false,
      }
    }))
    const complete = roles.every((item) => item.success === true)
    const covered = complete && roles.every((item) => item.reconciliation?.covered === true)
    return res.status(complete ? 200 : 503).json({
      success: complete,
      status: complete ? (covered ? 'both-sponsor-ledgers-covered' : 'role-reconciliation-complete-not-covered') : 'role-reconciliation-incomplete',
      network,
      checkedAt: new Date().toISOString(),
      accountsConfigured: true,
      configuredAddressesDistinct: true,
      covered,
      roles,
      canSubmitSponsoredTransfer: false,
      submissionEnabled: false,
      limitations: [
        'Each role is reconciled only against budget rows matching that role address and selected network.',
        'A covered ledger is a point-in-time accounting check; it does not prove signer authorization or zero network fees.',
        'Budget amounts are not receiver balances. No reservations, budgets, or transfer rows were changed.',
        'This route never signs, delegates, submits, broadcasts, or charges user funds.',
      ],
    })
  } catch {
    return res.status(503).json({
      success: false,
      error: 'sponsor-role-reconciliation-unavailable',
      canSubmitSponsoredTransfer: false,
      submissionEnabled: false,
      message: 'Could not complete both role-scoped reconciliations. No budget or transfer row was changed.',
    })
  }
})

// Read the configured sponsor's solidified resource limits and Stake-2.0
// delegation ceilings. Public chain metadata is read-only; no funds move here.
const readSponsorResourceStatus = createSponsorResourceReader()
router.get('/sponsorship/resource-status', async (req, res) => {
  res.setHeader?.('Cache-Control', 'no-store')
  res.setHeader?.('Pragma', 'no-cache')
  const network = req.query?.network
  const refreshValue = req.query?.refresh
  if (refreshValue !== undefined && refreshValue !== '0' && refreshValue !== '1') {
    return res.status(400).json({ success: false, error: 'invalid-refresh', message: 'refresh must be 0 or 1.' })
  }
  if (typeof network !== 'string' || !Object.hasOwn(networks, network)) {
    return res.status(400).json({ success: false, error: 'invalid-network', message: 'network must be mainnet, shasta, or nile.' })
  }
  try {
    const resources = await readSponsorResourceStatus(network, { refresh: refreshValue === '1' })
    const verifiedRead = resources?.success === true && resources?.resourceRead === true
    return res.status(verifiedRead ? 200 : 503).json({
      success: verifiedRead,
      resources,
      limitations: [
        'This endpoint queries solidified account resources and the maximum Stake-2.0 delegation size; it never signs or broadcasts a delegation or token transfer.',
        'Delegation ceilings are measured in SUN-equivalent staked TRX, not Energy units.',
        'A resource snapshot does not prove a later transaction will be fully covered; verify the resulting delegation and each transfer separately.',
        'No user-funded fallback is authorized by this endpoint.',
      ],
    })
  } catch {
    return res.status(502).json({ success: false, error: 'sponsor-resource-read-failed', message: 'Could not verify sponsor resources on the selected network.' })
  }
})

// Independently verify a wallet-signed Stake-2.0 delegation on solidified chain state
// before recording it in the project-scoped, idempotent audit ledger.
const verifySponsorResourceDelegation = createSponsorResourceDelegationVerifier()
// Read-only history of resource delegations that the backend independently
// verified against solidified transaction and delegation state and persisted.
router.get('/sponsorship/resource-delegations', async (req, res) => {
  res.setHeader?.('Cache-Control', 'no-store')
  res.setHeader?.('Pragma', 'no-cache')
  const network = req.query?.network
  const limitText = req.query?.limit === undefined ? '20' : req.query.limit
  const limit = typeof limitText === 'string' ? Number(limitText) : Number.NaN
  if (!['mainnet', 'shasta', 'nile'].includes(network)) {
    return res.status(400).json({ success: false, error: 'invalid-network', message: 'network must be mainnet, shasta, or nile.' })
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return res.status(400).json({ success: false, error: 'invalid-limit', message: 'limit must be an integer from 1 to 100.' })
  }
  const result = await listSponsorResourceDelegations({ network, limit })
  if (!result.success) {
    return res.status(result.reason === 'invalid-limit' || result.reason === 'invalid-network' ? 400 : 503)
      .json({ success: false, error: result.reason || 'resource-delegation-history-unavailable', delegations: [] })
  }
  return res.json({
    success: true,
    status: 'verified-resource-delegation-history',
    network,
    count: result.delegations.length,
    delegations: result.delegations,
    source: 'TRON Token Studio PostgreSQL audit ledger',
    note: 'Only resource delegations independently verified from solidified TRON transaction and resulting delegation state are listed. This is not a token-transfer history or proof that a later transfer had zero fees.',
  })
})

router.post('/sponsorship/resource-delegations/verify', async (req, res) => {
  res.setHeader?.('Cache-Control', 'no-store')
  res.setHeader?.('Pragma', 'no-cache')
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
  const allowedFields = new Set(['network', 'transactionId', 'sponsorAddress', 'receiverAddress', 'resourceType', 'stakeEquivalentSun'])
  if (Object.keys(body).some((key) => !allowedFields.has(key))) {
    return res.status(400).json({ success: false, verified: false, error: 'unexpected-fields', message: 'Submit only the public transaction ID, network, sponsor/receiver addresses, resource type, and stake-equivalent amount.' })
  }
  if (!['mainnet', 'shasta', 'nile'].includes(body.network)
    || typeof body.transactionId !== 'string' || !/^[0-9a-fA-F]{64}$/.test(body.transactionId)
    || !addressPattern.test(body.sponsorAddress || '')
    || !addressPattern.test(body.receiverAddress || '')
    || body.sponsorAddress === body.receiverAddress
    || !['ENERGY', 'BANDWIDTH'].includes(body.resourceType)
    || typeof body.stakeEquivalentSun !== 'string' || !/^[1-9][0-9]{0,15}$/.test(body.stakeEquivalentSun)) {
    return res.status(400).json({ success: false, verified: false, error: 'invalid-delegation-details', message: 'The resource-delegation record is malformed; no record was written.' })
  }
  // Only record delegations from the configured fee sponsor for this exact network.
  // Do not let a caller classify an arbitrary wallet's delegation as sponsor activity.
  const sponsorAddressEnvironment = `SPONSOR_FEE_${body.network.toUpperCase()}_ADDRESS`
  const configuredFeeSponsor = process.env[sponsorAddressEnvironment]?.trim()
  if (!configuredFeeSponsor || !addressPattern.test(configuredFeeSponsor)) {
    return res.status(503).json({
      success: false,
      verified: false,
      error: 'fee-sponsor-address-not-configured',
      requiredEnvironment: [sponsorAddressEnvironment],
      persistence: { persisted: false, reason: 'authorized-sponsor-not-configured' },
      message: 'Configure the network-specific fee-sponsor address before recording resource delegations.',
    })
  }
  if (body.sponsorAddress !== configuredFeeSponsor) {
    return res.status(403).json({
      success: false,
      verified: false,
      error: 'sponsor-address-not-authorized',
      persistence: { persisted: false, reason: 'sponsor-address-mismatch' },
      message: 'The delegation sponsor must match the configured fee-sponsor address for the selected network. No record was written.',
    })
  }
  try {
    const verification = await verifySponsorResourceDelegation({
      network: body.network,
      transactionId: body.transactionId,
      sponsorAddress: body.sponsorAddress,
      receiverAddress: body.receiverAddress,
      resourceType: body.resourceType,
      stakeEquivalentSun: body.stakeEquivalentSun,
    })
    if (verification?.verified !== true) {
      const transient = ['pending-solidification', 'delegation-state-not-yet-confirmed', 'provider-credentials-missing', 'provider-unavailable', 'provider-auth-rejected', 'provider-http-error', 'provider-unreachable'].includes(verification?.status)
      const code = ['pending-solidification', 'delegation-state-not-yet-confirmed'].includes(verification?.status) ? 409
        : verification?.status === 'invalid-request' || verification?.status === 'invalid-network' ? 400
          : transient ? 503 : 422
      return res.status(code).json({
        success: false,
        verified: false,
        verification,
        persistence: { persisted: false, reason: 'solidified-verification-required' },
        message: 'No sponsor resource delegation was recorded because the independent solidified-chain verification did not pass.',
      })
    }
    const persistence = await recordSponsorResourceDelegation({
      network: verification.network,
      transactionHash: verification.transactionId,
      sponsorAddress: verification.sponsorAddress,
      receiverAddress: verification.receiverAddress,
      resourceType: verification.resourceType,
      stakeEquivalentSun: verification.stakeEquivalentSun,
      blockNumber: verification.blockNumber,
    })
    if (persistence?.persisted !== true) {
      return res.status(503).json({
        success: false,
        verified: true,
        verification,
        persistence,
        message: 'The delegation was verified on solidified chain state, but its audit record was not persisted. Retry verification; do not treat the app audit history as complete yet.',
      })
    }
    return res.status(200).json({
      success: true,
      verified: true,
      verification,
      persistence,
      message: 'Solidified sponsor resource delegation verified and persisted to the project audit ledger.',
      limitations: [
        'This verifies resource delegation only; it does not verify a later token transfer, promise zero fees, or transfer token principal.',
        'Resource delegation is not a GasFree/provider-relayed sponsored transfer.',
      ],
    })
  } catch {
    return res.status(503).json({ success: false, verified: false, error: 'resource-delegation-verification-unavailable', persistence: { persisted: false, reason: 'verification-unavailable' }, message: 'Independent verification or audit persistence is unavailable. No verified record is confirmed.' })
  }
})

function hasValidSponsorAdminToken(req) {
  const configured = process.env.SPONSOR_ADMIN_API_TOKEN
  const authorization = req.headers?.authorization
  if (typeof configured !== 'string' || configured.length < 32
    || typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false
  const supplied = Buffer.from(authorization.slice(7))
  const expected = Buffer.from(configured)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

// Public intake stores only the provider name, business email, and scope. A privacy
// consent flag is required; secrets and signing material are never accepted or saved.
router.post('/sponsorship/provider-applications', async (req, res) => {
  res.setHeader?.('Cache-Control', 'no-store')
  res.setHeader?.('Pragma', 'no-cache')
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
  const allowedFields = new Set(['providerName', 'contactEmail', 'scope', 'privacyConsent'])
  if (Object.keys(body).some((key) => !allowedFields.has(key))) {
    return res.status(400).json({ success: false, error: 'unexpected-fields', message: 'Submit only providerName, contactEmail, scope, and privacyConsent. Do not submit credentials or signing material.' })
  }
  const providerName = typeof body.providerName === 'string' ? body.providerName.trim() : ''
  const contactEmail = typeof body.contactEmail === 'string' ? body.contactEmail.trim().toLowerCase() : ''
  const scope = body.scope
  if (providerName.length < 2 || providerName.length > 120 || /[\r\n\x00-\x1f]/.test(providerName)) {
    return res.status(400).json({ success: false, error: 'invalid-provider-name', message: 'Provider name must be 2 to 120 characters with no control characters.' })
  }
  if (contactEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(contactEmail)) {
    return res.status(400).json({ success: false, error: 'invalid-contact-email', message: 'Enter a valid business contact email address.' })
  }
  if (!providerApplicationScopes.has(scope)) {
    return res.status(400).json({ success: false, error: 'invalid-scope', allowedScopes: [...providerApplicationScopes] })
  }
  if (body.privacyConsent !== true) {
    return res.status(400).json({ success: false, error: 'privacy-consent-required', message: 'Consent is required before storing the provider name and business contact email for manual onboarding review.' })
  }

  const attempt = reserveProviderApplicationAttempt(contactEmail)
  if (!attempt.allowed) {
    return res.status(429).json({ success: false, error: 'application-rate-limited', retryAfterSeconds: attempt.retryAfterSeconds, message: 'Up to three applications per business email are accepted per hour. Check the existing reference status before trying again.' })
  }

  const reference = randomUUID()
  try {
    const result = await createSponsorProviderApplication({ reference, providerName, contactEmail, scope })
    if (!result.success) {
      releaseProviderApplicationAttempt(attempt)
      const status = result.reason === 'database-not-configured' || result.reason === 'database-unavailable' ? 503 : 400
      return res.status(status).json({
        success: false,
        error: result.reason || 'application-not-created',
        message: status === 503
          ? 'Provider applications cannot be stored right now. No application was confirmed; retry later.'
          : 'The provider application was rejected. Verify its fields and retry.',
      })
    }
    return res.status(201).json({
      success: true,
      application: result.application,
      providerSubmissionEnabled: false,
      feeSponsorshipEnabled: false,
      message: 'Application stored for manual provider due diligence. This is not a sponsor agreement, funding attestation, or transfer authorization.',
    })
  } catch {
    releaseProviderApplicationAttempt(attempt)
    return res.status(503).json({ success: false, error: 'application-storage-unavailable', message: 'Provider applications cannot be stored right now. No application was confirmed; retry later.' })
  }
})

// Reference-only status lookup deliberately omits provider name and contact email.
router.get('/sponsorship/provider-applications/:reference/status', async (req, res) => {
  res.setHeader?.('Cache-Control', 'no-store')
  res.setHeader?.('Pragma', 'no-cache')
  const reference = req.params?.reference
  if (typeof reference !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reference)) {
    return res.status(400).json({ success: false, error: 'invalid-application-reference' })
  }
  const result = await getSponsorProviderApplicationStatus(reference)
  if (!result.success) {
    const status = result.reason === 'application-not-found' ? 404
      : result.reason === 'invalid-reference' ? 400 : 503
    return res.status(status).json({ success: false, error: result.reason || 'application-status-unavailable' })
  }
  return res.json({
    success: true,
    application: result.application,
    providerSubmissionEnabled: false,
    feeSponsorshipEnabled: false,
  })
})

// Contact details are visible only through the server-only admin token.
router.get('/sponsorship/provider-applications', async (req, res) => {
  res.setHeader?.('Cache-Control', 'no-store')
  res.setHeader?.('Vary', 'Authorization')
  res.setHeader?.('Pragma', 'no-cache')
  if (typeof process.env.SPONSOR_ADMIN_API_TOKEN !== 'string' || process.env.SPONSOR_ADMIN_API_TOKEN.length < 32) {
    return res.status(503).json({ success: false, error: 'sponsor-admin-not-configured' })
  }
  if (!hasValidSponsorAdminToken(req)) {
    return res.status(401).json({ success: false, error: 'unauthorized' })
  }
  const status = req.query?.status === undefined ? null : req.query.status
  const limitText = req.query?.limit === undefined ? '50' : req.query.limit
  const limit = typeof limitText === 'string' ? Number(limitText) : Number.NaN
  if (status !== null && !['pending-review', 'in-review', 'accepted-for-due-diligence', 'declined', 'closed'].includes(status)) {
    return res.status(400).json({ success: false, error: 'invalid-status-filter' })
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return res.status(400).json({ success: false, error: 'invalid-limit', message: 'limit must be an integer from 1 to 100.' })
  }
  const result = await listSponsorProviderApplications({ status, limit })
  if (!result.success) return res.status(result.reason === 'invalid-query' ? 400 : 503).json({ success: false, error: result.reason || 'application-list-unavailable' })
  return res.json({ success: true, count: result.applications.length, applications: result.applications })
})

router.post('/sponsorship/provider-applications/:reference/review', async (req, res) => {
  res.setHeader?.('Cache-Control', 'no-store')
  res.setHeader?.('Vary', 'Authorization')
  res.setHeader?.('Pragma', 'no-cache')
  if (typeof process.env.SPONSOR_ADMIN_API_TOKEN !== 'string' || process.env.SPONSOR_ADMIN_API_TOKEN.length < 32) {
    return res.status(503).json({ success: false, error: 'sponsor-admin-not-configured' })
  }
  if (!hasValidSponsorAdminToken(req)) {
    return res.status(401).json({ success: false, error: 'unauthorized' })
  }
  const { status, reviewReference = null } = req.body || {}
  const result = await reviewSponsorProviderApplication({ reference: req.params?.reference, status, reviewReference })
  if (!result.success) {
    const code = result.reason === 'application-not-found' ? 404
      : result.reason === 'invalid-review' ? 400
        : result.reason === 'invalid-status-transition' ? 409 : 503
    return res.status(code).json({ success: false, error: result.reason || 'application-review-failed' })
  }
  return res.json({ success: true, application: result, feeSponsorshipEnabled: false, providerSubmissionEnabled: false })
})

// Testnet-only draft entry for separate sponsor roles. This records a pending-review
// cap under a server-configured sponsor address; it never activates, reserves, signs, or submits.
router.post('/sponsorship/role-budget-drafts', async (req, res) => {
  res.setHeader?.('Cache-Control', 'no-store')
  res.setHeader?.('Vary', 'Authorization')
  res.setHeader?.('Pragma', 'no-cache')
  if (typeof process.env.SPONSOR_ADMIN_API_TOKEN !== 'string'
    || process.env.SPONSOR_ADMIN_API_TOKEN.length < 32) {
    return res.status(503).json({
      success: false,
      error: 'sponsor-admin-not-configured',
      message: 'Sponsor budget drafting is disabled until a long server-only admin token is configured.',
      canSubmitSponsoredTransfer: false,
    })
  }
  if (!hasValidSponsorAdminToken(req)) {
    return res.status(401).json({ success: false, error: 'unauthorized', canSubmitSponsoredTransfer: false })
  }
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
  const allowed = new Set(['network', 'role', 'sponsorReference', 'asset', 'tokenContract', 'budgetBaseUnits'])
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    return res.status(400).json({ success: false, error: 'unexpected-fields', message: 'Only network, role, sponsor reference, asset, token contract and integer base-unit cap are accepted.' })
  }
  if (!['shasta', 'nile'].includes(body.network)) {
    return res.status(400).json({
      success: false,
      error: 'testnet-only-draft',
      message: 'Role-specific budget drafts are restricted to Shasta or Nile. Mainnet budget drafting is not available from this endpoint.',
      canSubmitSponsoredTransfer: false,
    })
  }
  if (!['network-fee-sponsor', 'asset-principal-sponsor'].includes(body.role)) {
    return res.status(400).json({ success: false, error: 'invalid-sponsor-role' })
  }
  const feeRole = body.role === 'network-fee-sponsor'
  if (feeRole && (body.asset !== 'TRX' || (body.tokenContract !== undefined && body.tokenContract !== null && body.tokenContract !== ''))
    || !feeRole && !['TRX', 'USDT', 'VTRC'].includes(body.asset)) {
    return res.status(400).json({
      success: false,
      error: 'role-asset-mismatch',
      message: 'The fee sponsor can draft only a native TRX resource/fee cap. The asset-principal sponsor may draft TRX, allowlisted USDT, or allowlisted VTRC.',
    })
  }
  const networkKey = body.network.toUpperCase()
  const addressEnv = feeRole
    ? `SPONSOR_FEE_${networkKey}_ADDRESS`
    : `SPONSOR_ASSET_${networkKey}_ADDRESS`
  const sponsorAddress = process.env[addressEnv]
  if (typeof sponsorAddress !== 'string' || !addressPattern.test(sponsorAddress.trim())) {
    return res.status(503).json({
      success: false,
      error: 'sponsor-role-address-not-configured',
      requiredEnvironment: [addressEnv],
      message: 'Configure the public address for this exact sponsor role and testnet; the client cannot choose the sponsor wallet.',
      canSubmitSponsoredTransfer: false,
    })
  }
  const purpose = feeRole ? 'network-fee' : 'asset-grant'
  const tokenContract = body.asset === 'TRX' ? null : body.tokenContract
  try {
    const result = await createSponsorBudgetDraft({
      network: body.network,
      sponsorReference: body.sponsorReference,
      purpose,
      asset: body.asset,
      tokenContract,
      budgetBaseUnits: body.budgetBaseUnits,
      sponsorAddress: sponsorAddress.trim(),
    })
    if (!result.success) {
      const status = result.reason === 'budget-already-exists' ? 409
        : result.reason === 'database-not-configured' ? 503
          : result.reason === 'invalid-tron-address' ? 400 : 400
      return res.status(status).json({
        success: false,
        error: result.reason || 'role-budget-draft-failed',
        message: result.reason === 'budget-already-exists'
          ? 'An equivalent draft already exists; no existing budget was modified.'
          : 'The role-specific draft was rejected. Verify the testnet, integer base units and configured token allowlist.',
        canSubmitSponsoredTransfer: false,
      })
    }
    return res.status(201).json({
      success: true,
      status: 'pending-review',
      role: body.role,
      purpose,
      ...result,
      canReserve: false,
      canSubmitSponsoredTransfer: false,
      submissionEnabled: false,
      note: 'The testnet draft is an internal cap only. It is not funding proof, sponsor consent, activation, a reservation, a grant, or a transfer.',
    })
  } catch {
    return res.status(503).json({
      success: false,
      error: 'role-budget-draft-unavailable',
      canSubmitSponsoredTransfer: false,
      message: 'Could not create the testnet draft. No transfer was submitted.',
    })
  }
})

// Draft-only sponsor budget creation. An approved operator token is required;
// each record starts pending-review and this route cannot activate or reserve a budget.
router.post('/sponsorship/budgets', async (req, res) => {
  res.setHeader?.('Cache-Control', 'no-store')
  res.setHeader?.('Vary', 'Authorization')
  res.setHeader?.('Pragma', 'no-cache')

  if (typeof process.env.SPONSOR_ADMIN_API_TOKEN !== 'string'
    || process.env.SPONSOR_ADMIN_API_TOKEN.length < 32) {
    return res.status(503).json({
      success: false,
      error: 'sponsor-admin-not-configured',
      message: 'Sponsor budget drafting is disabled until a long server-only admin token is configured.',
    })
  }
  if (!hasValidSponsorAdminToken(req)) {
    return res.status(401).json({ success: false, error: 'unauthorized', message: 'A valid sponsor ledger administrator token is required.' })
  }
  const { network, sponsorReference, purpose, asset, tokenContract = null, budgetBaseUnits } = req.body || {}
  if (typeof network !== 'string' || !Object.hasOwn(networks, network)) {
    return res.status(400).json({ success: false, error: 'invalid-network', message: 'network must be mainnet, shasta, or nile.' })
  }
  // Sponsor address is chosen from server-side configuration, never accepted from the client.
  const addressEnv = network === 'mainnet' ? 'SPONSOR_MAINNET_ADDRESS'
    : network === 'shasta' ? 'SPONSOR_SHASTA_ADDRESS' : 'SPONSOR_NILE_ADDRESS'
  const sponsorAddress = process.env[addressEnv]
  if (typeof sponsorAddress !== 'string' || !addressPattern.test(sponsorAddress.trim())) {
    return res.status(503).json({
      success: false,
      error: 'sponsor-address-not-configured',
      requiredEnvironment: [addressEnv],
      message: 'Configure the public sponsor wallet address server-side for this network before creating a budget draft.',
    })
  }
  try {
    const result = await createSponsorBudgetDraft({
      network, sponsorReference, purpose, asset, tokenContract,
      budgetBaseUnits, sponsorAddress: sponsorAddress.trim(),
    })
    if (!result.success) {
      const status = result.reason === 'budget-already-exists' ? 409
        : result.reason === 'database-not-configured' ? 503
          : result.reason === 'invalid-tron-address' ? 400
            : 400
      return res.status(status).json({
        success: false,
        error: result.reason || 'sponsor-budget-draft-failed',
        message: result.reason === 'budget-already-exists'
          ? 'A budget for this sponsor, network, purpose, asset and contract already exists; this endpoint does not modify existing budgets.'
          : 'The sponsor budget draft was rejected. Verify network, asset, exact contract allowlist, address and integer base-unit amount.',
      })
    }
    return res.status(201).json({
      ...result,
      status: 'pending-review',
      canReserve: false,
      canSubmitSponsoredTransfer: false,
      submissionEnabled: false,
      note: 'This draft records an operator-requested budget cap only. It is not a chain balance, funding attestation, sponsor consent, activation, reservation, or transfer.',
    })
  } catch {
    return res.status(503).json({ success: false, error: 'sponsor-budget-draft-unavailable', message: 'Could not create the sponsor budget draft.' })
  }
})

// Operator-only activation gate. The approved agreement reference must have been
// reviewed and allowlisted server-side; the on-chain balance snapshot must be fresh,
// exact-network, and sufficient for the total remaining allocation. This only makes
// a ledger budget eligible for internal reservations; it never signs or submits.
router.post('/sponsorship/budgets/:id/activate', async (req, res) => {
  res.setHeader?.('Cache-Control', 'no-store')
  res.setHeader?.('Pragma', 'no-cache')
  res.setHeader?.('Vary', 'Authorization')
  if (typeof process.env.SPONSOR_ADMIN_API_TOKEN !== 'string'
    || process.env.SPONSOR_ADMIN_API_TOKEN.length < 32) {
    return res.status(503).json({ success: false, error: 'sponsor-admin-not-configured' })
  }
  if (!hasValidSponsorAdminToken(req)) {
    return res.status(401).json({ success: false, error: 'unauthorized', message: 'A valid sponsor ledger administrator token is required.' })
  }
  const budgetId = req.params?.id
  if (typeof budgetId !== 'string' || !/^[1-9][0-9]{0,18}$/.test(budgetId)) {
    return res.status(400).json({ success: false, error: 'invalid-budget-id' })
  }
  const { consentReference, reviewReference } = req.body || {}
  const referencePattern = /^[A-Za-z0-9._:-]{8,160}$/
  if (typeof consentReference !== 'string' || !referencePattern.test(consentReference)
    || typeof reviewReference !== 'string' || !referencePattern.test(reviewReference)) {
    return res.status(400).json({
      success: false,
      error: 'invalid-activation-references',
      message: 'Provide a server-allowlisted sponsor agreement reference and a bounded operator review/ticket reference.',
    })
  }
  if (!isSponsorAgreementReferenceConfigured(consentReference)) {
    return res.status(403).json({
      success: false,
      error: 'agreement-reference-not-approved',
      message: 'This agreement reference has not been allowlisted after operator review.',
    })
  }

  try {
    const lookup = await getSponsorBudgetById(budgetId)
    if (!lookup.success) {
      const code = lookup.reason === 'budget-not-found' ? 404
        : lookup.reason === 'database-not-configured' ? 503 : 400
      return res.status(code).json({ success: false, error: lookup.reason || 'sponsor-budget-lookup-failed' })
    }
    const budget = lookup.budget
    if (!isApprovedSponsorAgreementScope({ consentReference, budget })) {
      return res.status(403).json({
        success: false,
        error: 'agreement-reference-not-approved-for-budget',
        message: 'The approved agreement does not cover this exact sponsor, network, purpose, asset, and token contract.',
      })
    }
    if (budget.status === 'active') {
      const sameApproval = budget.approval_reference === consentReference
        && budget.review_reference === reviewReference
        && budget.approved_at != null
      return sameApproval
        ? res.json({
            success: true, duplicate: true, status: 'active', budgetId,
            canReserve: true, canSubmitSponsoredTransfer: false, submissionEnabled: false,
            note: 'The same approved budget request was already applied. No transaction was submitted.',
          })
        : res.status(409).json({ success: false, error: 'budget-already-active' })
    }
    if (budget.status !== 'pending-review') {
      return res.status(409).json({
        success: false,
        error: budget.status === 'paused' ? 'budget-paused' : 'budget-not-pending-review',
        message: 'Only a pending-review draft can be activated through this route.',
      })
    }
    if (budget.network === 'mainnet' && process.env.SPONSOR_MAINNET_BUDGET_ACTIVATION_ENABLED !== 'true') {
      return res.status(503).json({
        success: false,
        error: 'mainnet-budget-activation-disabled',
        message: 'Mainnet budget activation remains off until an operator separately enables the reviewed Mainnet gate.',
      })
    }

    const roleResult = await readSponsorRoleFunding(budget.network, { refresh: true })
    if (roleResult?.success !== true || roleResult?.accountsConfigured !== true) {
      return res.status(503).json({
        success: false,
        error: 'sponsor-role-addresses-not-configured',
        requiredEnvironment: [
          `SPONSOR_FEE_${budget.network.toUpperCase()}_ADDRESS`,
          `SPONSOR_ASSET_${budget.network.toUpperCase()}_ADDRESS`,
        ],
        message: 'Both network-fee and asset-principal sponsor addresses must be configured before a role budget can be activated.',
      })
    }
    if (roleResult.configuredAddressesDistinct !== true) {
      return res.status(409).json({
        success: false,
        error: 'sponsor-role-addresses-not-distinct',
        message: 'The fee sponsor and asset-principal sponsor must be distinct accounts before activating a role budget.',
      })
    }

    const roleName = budget.purpose === 'network-fee' ? 'networkFeeSponsor' : 'assetPrincipalSponsor'
    const fundingSnapshot = roleResult.fundingSnapshots?.[roleName]
    if (!fundingSnapshot || fundingSnapshot.network !== budget.network) {
      return res.status(503).json({
        success: false,
        error: 'sponsor-role-snapshot-unavailable',
        message: 'The matching sponsor role did not return a snapshot for this network. The budget remains pending-review.',
      })
    }
    if (fundingSnapshot.sponsorAddress !== budget.sponsor_address) {
      return res.status(409).json({
        success: false,
        error: 'sponsor-budget-role-address-mismatch',
        message: 'The budget address does not match the configured sponsor for its purpose and network. No budget was activated.',
      })
    }
    if (fundingSnapshot?.cache?.status !== 'fresh') {
      return res.status(503).json({
        success: false,
        error: 'funding-snapshot-refresh-throttled',
        retryAfterMs: Math.max(0, Number(fundingSnapshot?.retryAfterMs) || 0),
        message: 'A fresh solidified snapshot for the exact sponsor role is required. The old snapshot was not used to activate this budget.',
      })
    }
    if (fundingSnapshot?.onChainBalanceRead !== true) {
      return res.status(503).json({
        success: false,
        error: 'fresh-sponsor-balance-unavailable',
        message: 'The matching sponsor role balance could not be verified from solidified chain state; the budget remains pending-review.',
      })
    }

    const activated = await activateSponsorBudget({
      budgetId,
      consentReference,
      reviewReference,
      fundingSnapshot,
    })
    if (!activated.success) {
      const statusCode = ['agreement-reference-not-approved'].includes(activated.reason) ? 403
        : activated.reason === 'budget-not-found' ? 404
          : ['budget-already-active', 'budget-paused', 'budget-not-pending-review', 'budget-already-depleted'].includes(activated.reason) ? 409
            : activated.reason === 'insufficient-onchain-funding' ? 422
              : ['mainnet-budget-activation-disabled', 'funding-snapshot-stale', 'fresh-solidified-funding-snapshot-required', 'exact-asset-balance-not-verified', 'official-mainnet-usdt-decimals-mismatch', 'database-not-configured'].includes(activated.reason) ? 503
                : ['funding-snapshot-identity-mismatch', 'budget-identity-changed'].includes(activated.reason) ? 502 : 400
      return res.status(statusCode).json({
        success: false,
        error: activated.reason || 'sponsor-budget-activation-failed',
        ...(activated.requiredBaseUnits ? { requiredBaseUnits: activated.requiredBaseUnits } : {}),
        ...(activated.chainBalanceBaseUnits ? { chainBalanceBaseUnits: activated.chainBalanceBaseUnits } : {}),
        message: activated.reason === 'insufficient-onchain-funding'
          ? 'The fresh chain balance cannot cover this budget plus existing active/paused allocations for the same wallet, network, and asset.'
          : 'Budget activation was rejected; it remains unavailable for new reservations.',
      })
    }

    return res.status(200).json({
      success: true,
      status: 'active',
      ...activated,
      chainBalanceReconciled: true,
      canReserve: true,
      canSubmitSponsoredTransfer: false,
      submissionEnabled: false,
      transactionSigned: false,
      transactionSubmitted: false,
      note: 'This approves the internal reservation cap only. It does not authorize a particular transfer, sign or broadcast a transaction, or prove exchange deposit credit.',
    })
  } catch {
    return res.status(503).json({
      success: false,
      error: 'sponsor-budget-activation-unavailable',
      message: 'Could not complete sponsor budget activation. The budget was not reported active.',
    })
  }
})

// Read-only reconciliation compares the current chain snapshot with every
// sponsor budget on the selected network. It never changes budget rows.
router.get('/sponsorship/reconciliation', async (req, res) => {
  res.setHeader?.('Cache-Control', 'no-store')
  res.setHeader?.('Pragma', 'no-cache')
  res.setHeader?.('Vary', 'Authorization')
  if (typeof process.env.SPONSOR_ADMIN_API_TOKEN !== 'string'
    || process.env.SPONSOR_ADMIN_API_TOKEN.length < 32) {
    return res.status(503).json({ success: false, error: 'sponsor-admin-not-configured' })
  }
  if (!hasValidSponsorAdminToken(req)) {
    return res.status(401).json({ success: false, error: 'unauthorized', message: 'A valid sponsor ledger administrator token is required.' })
  }
  const network = req.query?.network
  if (typeof network !== 'string' || !Object.hasOwn(networks, network)) {
    return res.status(400).json({ success: false, error: 'invalid-network', message: 'network must be mainnet, shasta, or nile.' })
  }

  try {
    const fundingSnapshot = await readSponsorFundingStatus(network, { refresh: true })
    if (fundingSnapshot?.cache?.status !== 'fresh') {
      return res.status(503).json({
        success: false,
        error: 'funding-snapshot-refresh-throttled',
        retryAfterMs: Math.max(0, Number(fundingSnapshot?.retryAfterMs) || 0),
        message: 'A fresh solidified balance snapshot is required. Wait for the per-network refresh interval and retry; no stale snapshot was used for reconciliation.',
      })
    }
    if (fundingSnapshot?.onChainBalanceRead !== true) {
      return res.status(503).json({
        success: false,
        error: 'fresh-sponsor-balance-unavailable',
        message: 'The sponsor balance could not be verified on this network. The ledger was not reported as covered.',
      })
    }

    const ledger = await listSponsorBudgets({ network, limit: 100 })
    if (!ledger.success) {
      return res.status(503).json({
        success: false,
        error: 'sponsor-budget-ledger-unavailable',
        reason: ledger.reason,
      })
    }
    // A full page may be truncated; do not say "covered" unless every budget
    // on this network can be included in the reconciliation.
    if (ledger.budgets.length >= 100) {
      return res.status(503).json({
        success: false,
        error: 'sponsor-budget-ledger-truncated',
        message: 'There are at least 100 sponsor budget records for this network. Narrow the ledger query or add pagination before reconciliation; coverage has not been asserted.',
      })
    }

    const budgets = ledger.budgets.map((budget) => ({
      ...budget,
      approvalScopeVerified: budget.status === 'active'
        && typeof budget.review_reference === 'string'
        && budget.review_reference.length > 0
        && budget.approved_at != null
        && isApprovedSponsorAgreementScope({
          consentReference: budget.approval_reference,
          budget,
        }),
    }))
    const reconciliation = reconcileSponsorBudgets({
      network,
      fundingSnapshot,
      budgets,
    })
    return res.status(200).json({
      success: reconciliation.success,
      status: reconciliation.status,
      covered: reconciliation.covered === true,
      reconciliation,
      source: 'read-only Tatum solidified chain snapshot + TRON Token Studio sponsor ledger',
      limitations: [
        'The result is a point-in-time reconciliation; funds may move after the snapshot.',
        'Active budgets lacking an exact current agreement approval are flagged, not treated as eligible.',
        'A covered ledger does not verify signing authority or authorize a transaction.',
        'No budget or transfer row was changed, and no transaction was signed or submitted.',
      ],
    })
  } catch {
    return res.status(503).json({
      success: false,
      error: 'sponsor-reconciliation-unavailable',
      message: 'Could not complete sponsor funding reconciliation. No budget was changed.',
    })
  }
})

// Emergency pause for a configured sponsor budget. Requires the protected admin token.
// This prevents new reservations against the budget; it cannot reverse submitted transactions.
router.post('/sponsorship/budgets/:id/pause', async (req, res) => {
  res.setHeader?.('Cache-Control', 'no-store')
  res.setHeader?.('Pragma', 'no-cache')
  res.setHeader?.('Vary', 'Authorization')
  if (typeof process.env.SPONSOR_ADMIN_API_TOKEN !== 'string'
    || process.env.SPONSOR_ADMIN_API_TOKEN.length < 32) {
    return res.status(503).json({ success: false, error: 'sponsor-admin-not-configured' })
  }
  if (!hasValidSponsorAdminToken(req)) {
    return res.status(401).json({ success: false, error: 'unauthorized', message: 'A valid sponsor ledger administrator token is required.' })
  }
  const budgetId = req.params?.id
  if (typeof budgetId !== 'string' || !/^[1-9][0-9]{0,18}$/.test(budgetId)) {
    return res.status(400).json({ success: false, error: 'invalid-budget-id' })
  }
  const reasonCode = req.body?.reasonCode
  if (!['operator-request', 'funding-mismatch', 'provider-incident', 'emergency-stop'].includes(reasonCode)) {
    return res.status(400).json({
      success: false,
      error: 'invalid-pause-reason',
      allowedReasonCodes: ['operator-request', 'funding-mismatch', 'provider-incident', 'emergency-stop'],
    })
  }
  try {
    const result = await pauseSponsorBudget({ budgetId, reasonCode })
    if (!result.success) {
      const httpStatus = result.reason === 'budget-not-found' ? 404
        : result.reason === 'budget-already-depleted' ? 409
          : result.reason === 'database-not-configured' ? 503 : 400
      return res.status(httpStatus).json({
        success: false,
        error: result.reason,
        message: result.reason === 'budget-not-found'
          ? 'No sponsor budget exists for this ID.'
          : result.reason === 'budget-already-depleted'
            ? 'This budget is already depleted.'
            : 'The sponsor budget could not be paused.',
      })
    }
    return res.json({
      success: true,
      status: 'paused',
      ...result,
      canReserve: false,
      canSubmitSponsoredTransfer: false,
      submissionEnabled: false,
      note: 'The budget is paused for new reservations. Any already-submitted on-chain transaction is not cancelled or reversed by this action.',
    })
  } catch {
    return res.status(503).json({ success: false, error: 'sponsor-budget-pause-unavailable', message: 'Could not pause the sponsor budget.' })
  }
})

// Privileged, read-only view of configured sponsor budget caps and ledger usage.
// Budget values are not chain balances and this endpoint cannot activate budgets or send transfers.
router.get('/sponsorship/budgets', async (req, res) => {
  res.setHeader?.('Cache-Control', 'no-store')
  res.setHeader?.('Vary', 'Authorization')
  res.setHeader?.('Pragma', 'no-cache')

  if (typeof process.env.SPONSOR_ADMIN_API_TOKEN !== 'string'
    || process.env.SPONSOR_ADMIN_API_TOKEN.length < 32) {
    return res.status(503).json({
      success: false,
      error: 'sponsor-admin-not-configured',
      message: 'The sponsor ledger view is disabled until a long server-only admin token is configured.',
    })
  }
  if (!hasValidSponsorAdminToken(req)) {
    return res.status(401).json({ success: false, error: 'unauthorized', message: 'A valid sponsor ledger administrator token is required.' })
  }
  const network = req.query?.network === undefined ? null : req.query.network
  const limitValue = req.query?.limit === undefined ? '50' : req.query.limit
  const limit = Number(limitValue)
  if (network !== null && (typeof network !== 'string' || !Object.hasOwn(networks, network))) {
    return res.status(400).json({ success: false, error: 'invalid-network', message: 'network must be mainnet, shasta, or nile.' })
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return res.status(400).json({ success: false, error: 'invalid-limit', message: 'limit must be an integer from 1 to 100.' })
  }
  try {
    const result = await listSponsorBudgets({ network, limit })
    if (!result.success) {
      const status = result.reason === 'invalid-network' || result.reason === 'invalid-limit' ? 400 : 503
      return res.status(status).json({
        success: false,
        error: 'sponsor-budget-ledger-unavailable',
        reason: result.reason,
        message: 'Could not read the sponsor budget ledger.',
      })
    }
    return res.json({
      success: true,
      status: 'sponsor-budget-ledger-read',
      network,
      count: result.budgets.length,
      budgets: result.budgets,
      source: 'TRON Token Studio sponsor budget ledger',
      limitations: [
        'Ledger available base units are operator-configured budget minus reservations and recorded spend, not a live wallet balance.',
        'A budget record does not verify sponsor consent, chain funding, signing authority, or permission to submit.',
        'Budget listing is read-only and cannot activate a budget, reserve funds, or submit a transfer.',
      ],
    })
  } catch {
    return res.status(503).json({ success: false, error: 'sponsor-budget-ledger-unavailable', message: 'Could not read the sponsor budget ledger.' })
  }
})

// Keep SUN conversion exact; native balances can exceed Number's safe integer range.
const formatSun = (value) => {
  const sun = BigInt(value)
  const whole = sun / 1_000_000n
  const fraction = (sun % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

// Read a receiver's native TRX balance from the selected network's solidified state.
// Protected, read-only lifecycle history. It exposes no provider keys and cannot
// mutate a transfer or infer confirmation from a transaction hash alone.
// Reserve an explicitly approved testnet sponsor transfer against the correct sponsor role.
 // Reservation is an internal budget mutation only; this route never signs or broadcasts.
router.post('/sponsorship/transfers/reserve', async (req, res) => {
  res.setHeader?.('Cache-Control', 'no-store')
  res.setHeader?.('Pragma', 'no-cache')
  res.setHeader?.('Vary', 'Authorization')
  if (typeof process.env.SPONSOR_ADMIN_API_TOKEN !== 'string'
    || process.env.SPONSOR_ADMIN_API_TOKEN.length < 32) {
    return res.status(503).json({
      success: false,
      error: 'sponsor-admin-not-configured',
      canSubmitSponsoredTransfer: false,
      message: 'Transfer reservations require the server-only sponsor administrator token.',
    })
  }
  if (!hasValidSponsorAdminToken(req)) {
    return res.status(401).json({
      success: false,
      error: 'unauthorized',
      canSubmitSponsoredTransfer: false,
    })
  }

  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
  const allowed = new Set([
    'idempotencyKey', 'network', 'sponsorReference', 'purpose',
    'asset', 'tokenContract', 'receiverAddress', 'amountBaseUnits',
  ])
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    return res.status(400).json({
      success: false,
      error: 'unexpected-fields',
      canSubmitSponsoredTransfer: false,
      message: 'Only the reservation identity, approved budget scope, recipient, asset contract and integer base-unit amount are accepted. Signing material and transaction payloads are not accepted.',
    })
  }
  if (!['shasta', 'nile'].includes(body.network)) {
    return res.status(400).json({
      success: false,
      error: 'testnet-only-reservation',
      canSubmitSponsoredTransfer: false,
      message: 'Sponsor reservations are restricted to Shasta and Nile until separate production approval exists.',
    })
  }
  if (typeof body.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,160}$/.test(body.idempotencyKey)
    || typeof body.sponsorReference !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.sponsorReference)
    || !['network-fee', 'asset-grant'].includes(body.purpose)
    || !['TRX', 'USDT', 'VTRC'].includes(body.asset)
    || (body.purpose === 'network-fee' && body.asset !== 'TRX')
    || (body.asset === 'TRX' && body.tokenContract != null && body.tokenContract !== '')
    || (body.asset !== 'TRX' && (typeof body.tokenContract !== 'string' || !body.tokenContract.trim()))
    || typeof body.receiverAddress !== 'string' || !addressPattern.test(body.receiverAddress)
    || typeof body.amountBaseUnits !== 'string' || !/^[1-9][0-9]{0,77}$/.test(body.amountBaseUnits)) {
    return res.status(400).json({
      success: false,
      error: 'invalid-transfer-intent',
      canSubmitSponsoredTransfer: false,
      message: 'The reservation request is malformed. Amounts must be positive integer base units; use an allowlisted contract for token assets.',
    })
  }

  const roleName = body.purpose === 'network-fee' ? 'networkFeeSponsor' : 'assetPrincipalSponsor'
  try {
    // The database helper checks for a matching idempotency record before invoking
    // this reader. Therefore retries do not need a new provider request or create a
    // second reservation. New requests require a fresh snapshot from the exact role.
    const reservation = await reserveSponsorTransfer({
      idempotencyKey: body.idempotencyKey,
      sponsorReference: body.sponsorReference,
      network: body.network,
      purpose: body.purpose,
      asset: body.asset,
      tokenContract: body.asset === 'TRX' ? null : body.tokenContract.trim(),
      receiverAddress: body.receiverAddress,
      amountBaseUnits: body.amountBaseUnits,
    }, {
      fundingSnapshotReader: async (network) => {
        if (network !== body.network) return { status: 'invalid-network', network, onChainBalanceRead: false }
        const roleResult = await readSponsorRoleFunding(network, { refresh: true })
        if (roleResult?.success !== true || roleResult?.accountsConfigured !== true
          || roleResult?.configuredAddressesDistinct !== true) {
          return {
            status: roleResult?.accountsConfigured === false ? 'sponsor-role-addresses-missing' : 'sponsor-role-status-unavailable',
            network,
            onChainBalanceRead: false,
            sponsorFundingVerified: false,
            canSubmitSponsoredTransfer: false,
            submissionEnabled: false,
          }
        }
        const snapshot = roleResult.fundingSnapshots?.[roleName]
        if (!snapshot || snapshot.network !== network) {
          return { status: 'sponsor-role-snapshot-unavailable', network, onChainBalanceRead: false }
        }
        return snapshot
      },
    })

    if (reservation?.reserved !== true) {
      const reason = reservation?.reason || 'reservation-unavailable'
      const conflictReasons = new Set([
        'sponsor-budget-not-found', 'sponsor-budget-not-active',
        'sponsor-budget-activation-required', 'mainnet-budget-activation-disabled',
        'insufficient-sponsor-budget', 'insufficient-onchain-funding',
        'funding-snapshot-identity-mismatch', 'idempotency-key-conflict',
        'sponsor-role-addresses-not-distinct', 'invalid-request',
      ])
      const clientErrorReasons = new Set([
        'invalid-transfer-intent', 'invalid-tron-address', 'invalid-network',
      ])
      const httpStatus = clientErrorReasons.has(reason) ? 400
        : conflictReasons.has(reason) ? 409
          : 503
      return res.status(httpStatus).json({
        success: false,
        error: reason,
        canSubmitSponsoredTransfer: false,
        transactionBroadcast: false,
        message: reason === 'fresh-sponsor-balance-unavailable' || reason === 'sponsor-funding-snapshot-unavailable'
          ? 'A fresh solidified balance snapshot for the exact sponsor role could not be verified. No reservation was created.'
          : 'The reservation was rejected by sponsor authorization, budget, funding or idempotency checks. No transaction was signed or broadcast.',
      })
    }

    return res.status(reservation.duplicate ? 200 : 201).json({
      success: true,
      status: reservation.status || 'pending-review',
      reservation: {
        idempotencyKey: body.idempotencyKey,
        sponsorReference: body.sponsorReference,
        network: body.network,
        purpose: body.purpose,
        asset: body.asset,
        tokenContract: body.asset === 'TRX' ? null : body.tokenContract.trim(),
        receiverAddress: body.receiverAddress,
        amountBaseUnits: body.amountBaseUnits,
        duplicate: reservation.duplicate === true,
        fundingReconciled: reservation.fundingReconciled === true,
      },
      canSubmitSponsoredTransfer: false,
      submissionEnabled: false,
      providerSubmissionAttempted: false,
      transactionBroadcast: false,
      unpaidFallbackToUserFunds: false,
      message: 'The approved testnet budget reservation is recorded. This is not a transfer: provider submission remains disabled and no funds were signed or broadcast.',
    })
  } catch {
    return res.status(503).json({
      success: false,
      error: 'sponsor-transfer-reservation-unavailable',
      canSubmitSponsoredTransfer: false,
      providerSubmissionAttempted: false,
      transactionBroadcast: false,
      message: 'Could not reserve the approved testnet sponsor budget. No transfer was signed or broadcast.',
    })
  }
})

router.get('/sponsorship/transfers', async (req, res) => {
  res.setHeader?.('Cache-Control', 'no-store')
  res.setHeader?.('Pragma', 'no-cache')
  res.setHeader?.('Vary', 'Authorization')
  if (typeof process.env.SPONSOR_ADMIN_API_TOKEN !== 'string'
    || process.env.SPONSOR_ADMIN_API_TOKEN.length < 32) {
    return res.status(503).json({ success: false, error: 'sponsor-admin-not-configured' })
  }
  if (!hasValidSponsorAdminToken(req)) {
    return res.status(401).json({ success: false, error: 'unauthorized', message: 'A valid sponsor ledger administrator token is required.' })
  }
  const network = req.query?.network === undefined ? null : req.query.network
  const status = req.query?.status === undefined ? null : req.query.status
  const sponsorReference = req.query?.sponsorReference === undefined ? null : req.query.sponsorReference
  const limit = req.query?.limit === undefined ? 50 : Number(req.query.limit)
  if (network !== null && (typeof network !== 'string' || !Object.hasOwn(networks, network))) {
    return res.status(400).json({ success: false, error: 'invalid-network' })
  }
  if (status !== null && (typeof status !== 'string'
    || !['pending-review', 'authorized', 'submitted', 'confirmed', 'failed', 'cancelled'].includes(status))) {
    return res.status(400).json({ success: false, error: 'invalid-status' })
  }
  if (sponsorReference !== null && (typeof sponsorReference !== 'string'
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(sponsorReference))) {
    return res.status(400).json({ success: false, error: 'invalid-sponsor-reference' })
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return res.status(400).json({ success: false, error: 'invalid-limit' })
  }
  try {
    const result = await listSponsorTransfers({ network, status, sponsorReference, limit })
    if (!result.success) {
      const code = ['invalid-network', 'invalid-status', 'invalid-sponsor-reference', 'invalid-limit'].includes(result.reason) ? 400 : 503
      return res.status(code).json({
        success: false,
        error: 'sponsor-transfer-history-unavailable',
        reason: result.reason,
      })
    }
    return res.json({
      success: true,
      status: 'sponsor-transfer-history-read',
      count: result.transfers.length,
      truncated: result.truncated,
      transfers: result.transfers,
      source: 'TRON Token Studio sponsor transfer ledger',
      limitations: [
        'These are internal lifecycle records, not independent proof of chain execution or receiver credit.',
        'A submitted transaction remains pending until exact-network, exact-asset, sender, receiver and amount evidence is independently verified.',
        'This endpoint is read-only; it cannot authorize, submit, cancel, confirm, or release reservations.',
      ],
    })
  } catch {
    return res.status(503).json({ success: false, error: 'sponsor-transfer-history-unavailable' })
  }
})

router.get('/native-balance', async (req, res) => {
  const { network, address } = req.query
  if (typeof network !== 'string' || !Object.hasOwn(networks, network)) {
    return res.status(400).json({ success: false, error: 'invalid-network', message: 'network must be mainnet, shasta, or nile.' })
  }
  if (typeof address !== 'string' || !addressPattern.test(address)) {
    return res.status(400).json({ success: false, error: 'invalid-address', message: 'Provide a valid TRON Base58 receiver address.' })
  }
  try {
    const { TronWeb } = await import('tronweb')
    const tronWeb = new TronWeb({ fullHost: networks[network] })
    if (!tronWeb.isAddress(address)) return res.status(400).json({ success: false, error: 'invalid-address' })
    const headers = { 'content-type': 'application/json' }
    if (process.env.TRONGRID_API_KEY) headers['TRON-PRO-API-KEY'] = process.env.TRONGRID_API_KEY
    const response = await fetch(networks[network] + '/walletsolidity/getaccount', {
      method: 'POST', headers,
      body: JSON.stringify({ address: tronWeb.address.toHex(address), visible: false }),
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) throw new Error('solidified-provider-unavailable')
    const account = await response.json()
    const balanceSun = String(account?.balance ?? 0)
    if (!/^[0-9]+$/.test(balanceSun)) throw new Error('invalid-solidified-balance')
    return res.json({
      success: true,
      status: 'solidified-native-balance-read',
      network,
      address,
      accountExists: Boolean(account?.address),
      balanceSun,
      balanceTRX: formatSun(balanceSun),
      source: 'TRON SolidityNode getaccount',
      note: 'This is native TRX on the selected network only. It does not query TRC20 tokens or confirm exchange deposit credit.',
    })
  } catch {
    return res.status(502).json({ success: false, error: 'solidified-native-balance-read-failed', message: 'Could not read native TRX balance from the selected network solidified state.' })
  }
})

// Read-only verification for native TRX transfers. Both the transaction body
// and receipt must be visible from the selected network's solidified node.
router.get('/verify-native-transfer/:hash', async (req, res) => {
  const { hash } = req.params
  const { network, from, to, amountSun } = req.query

  if (!txPattern.test(hash)) {
    return res.status(400).json({ success: false, verified: false, error: 'invalid-transaction-id' })
  }
  if (typeof network !== 'string' || !Object.hasOwn(networks, network)) {
    return res.status(400).json({ success: false, verified: false, error: 'invalid-network', message: 'network must be mainnet, shasta, or nile.' })
  }

  const hasExpectedFields = from !== undefined || to !== undefined || amountSun !== undefined
  if (hasExpectedFields && !(typeof from === 'string' && typeof to === 'string' && typeof amountSun === 'string')) {
    return res.status(400).json({ success: false, verified: false, error: 'incomplete-expected-transfer', message: 'When checking expected values, provide from, to, and amountSun together.' })
  }
  if (hasExpectedFields && (!addressPattern.test(from) || !addressPattern.test(to) || !/^[0-9]+$/.test(amountSun) || BigInt(amountSun) <= 0n)) {
    return res.status(400).json({ success: false, verified: false, error: 'invalid-expected-transfer', message: 'Use valid TRON Base58 addresses and a positive amountSun integer; 1 TRX = 1000000 sun.' })
  }

  try {
    const { TronWeb } = await import('tronweb')
    const tronWeb = new TronWeb({ fullHost: networks[network] })
    if (hasExpectedFields && (!tronWeb.isAddress(from) || !tronWeb.isAddress(to))) {
      return res.status(400).json({ success: false, verified: false, error: 'invalid-expected-address' })
    }
    const expectedFrom = hasExpectedFields ? tronWeb.address.toHex(from).replace(/^0x/i, '').toLowerCase() : null
    const expectedTo = hasExpectedFields ? tronWeb.address.toHex(to).replace(/^0x/i, '').toLowerCase() : null
    const headers = { 'content-type': 'application/json' }
    if (process.env.TRONGRID_API_KEY) headers['TRON-PRO-API-KEY'] = process.env.TRONGRID_API_KEY

    const query = async (path) => {
      const response = await fetch(networks[network] + path, {
        method: 'POST',
        headers,
        body: JSON.stringify({ value: hash, visible: false }),
        signal: AbortSignal.timeout(8000),
      })
      if (!response.ok) throw new Error('provider-unavailable')
      return response.json()
    }

    const [transaction, receipt] = await Promise.all([
      query('/walletsolidity/gettransactionbyid'),
      query('/walletsolidity/gettransactioninfobyid'),
    ])
    if (transaction?.txID?.toLowerCase() !== hash.toLowerCase() || receipt?.id?.toLowerCase() !== hash.toLowerCase() || !Number.isInteger(receipt?.blockNumber)) {
      return res.status(202).json({
        success: true,
        verified: false,
        status: 'awaiting-solidification',
        network,
        transactionId: hash,
        message: 'The solidified transaction body and receipt are not both available yet. Retry this same transaction ID; do not send another transfer just because this one is pending.',
      })
    }

    const contract = transaction.raw_data?.contract?.find((item) => item.type === 'TransferContract')
    const value = contract?.parameter?.value
    const actualFrom = String(value?.owner_address || '').replace(/^0x/i, '').toLowerCase()
    const actualTo = String(value?.to_address || '').replace(/^0x/i, '').toLowerCase()
    const actualAmountSun = value?.amount === undefined ? null : String(value.amount)
    const contractResult = transaction.ret?.[0]?.contractRet || null
    const checks = {
      nativeTransfer: Boolean(contract),
      executionSucceeded: contractResult === 'SUCCESS',
      solidifiedReceiptPresent: receipt.id?.toLowerCase() === hash.toLowerCase() && Number.isInteger(receipt.blockNumber),
      ...(hasExpectedFields ? {
        senderMatches: actualFrom === expectedFrom,
        receiverMatches: actualTo === expectedTo,
        amountMatches: actualAmountSun === amountSun,
      } : {}),
    }
    const verified = Boolean(contract) && contractResult === 'SUCCESS' &&
      checks.solidifiedReceiptPresent &&
      (!hasExpectedFields || (checks.senderMatches && checks.receiverMatches && checks.amountMatches))

    let senderAddress = value?.owner_address ?? null
    let receiverAddress = value?.to_address ?? null
    try {
      if (senderAddress && /^[0-9a-fA-F]{42}$/.test(senderAddress)) senderAddress = tronWeb.address.fromHex(senderAddress)
      if (receiverAddress && /^[0-9a-fA-F]{42}$/.test(receiverAddress)) receiverAddress = tronWeb.address.fromHex(receiverAddress)
    } catch { /* Preserve provider-returned address if conversion is unsupported. */ }

    let verificationPersistence = { persisted: false, reason: 'transfer-not-verified' }
    if (verified && senderAddress && receiverAddress && actualAmountSun && Number.isSafeInteger(receipt.blockNumber)) {
      try {
        verificationPersistence = await recordNativeTransferVerification({
          network,
          transactionHash: hash,
          fromAddress: senderAddress,
          toAddress: receiverAddress,
          amountSun: actualAmountSun,
          blockNumber: receipt.blockNumber,
        })
      } catch {
        verificationPersistence = { persisted: false, reason: 'database-persistence-failed' }
      }
    }

    return res.json({
      success: true,
      verified,
      verificationPersistence,
      status: verified ? 'solidified-transfer-verified' : 'solidified-transfer-mismatch-or-failed',
      network,
      transactionId: hash,
      blockNumber: receipt.blockNumber,
      timestamp: receipt.blockTimeStamp ?? null,
      from: senderAddress,
      to: receiverAddress,
      amountSun: actualAmountSun,
      amountTRX: actualAmountSun === null ? null : formatSun(actualAmountSun),
      contractResult,
      checks,
      source: 'TRON SolidityNode transaction body and receipt',
      note: 'This verifies native TRX on-chain only; it does not verify any TRC20 token balance or exchange deposit credit.',
    })
  } catch {
    return res.status(502).json({
      success: false,
      verified: false,
      error: 'solidified-verification-unavailable',
      message: 'Could not query the selected TRON network. Retry later with the same transaction ID.',
    })
  }
})



/** Read persisted worker results separately from the live indexer feed. */
router.get('/receiver-history/persisted', async (req, res) => {
  const { network, address, contract } = req.query
  const limitValue = req.query.limit === undefined ? '50' : req.query.limit
  const limit = Number(limitValue)
  if (typeof network !== 'string' || !Object.hasOwn(networks, network)) {
    return res.status(400).json({ success: false, error: 'invalid-network' })
  }
  if (typeof address !== 'string' || !addressPattern.test(address)) {
    return res.status(400).json({ success: false, error: 'invalid-address' })
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    return res.status(400).json({ success: false, error: 'invalid-limit', message: 'limit must be an integer from 1 to 50.' })
  }
  if (contract !== undefined && (typeof contract !== 'string' || !addressPattern.test(contract))) {
    return res.status(400).json({ success: false, error: 'invalid-contract' })
  }
  try {
    const result = await listPersistedReceiverHistory({ network, address, contract: contract || null, limit })
    if (!result.success) {
      if (result.reason === 'invalid-query') return res.status(400).json({ success: false, error: 'invalid-query' })
      return res.status(503).json({ success: false, error: 'persisted-history-unavailable', reason: result.reason })
    }
    return res.json({
      success: true,
      status: 'persisted-receiver-history',
      network,
      address,
      count: result.records.length,
      records: result.records,
      source: 'TRON Token Studio receiver-history database',
      note: 'Persisted records are only verified when verifiedOnChain is true and verificationStatus is verified-on-chain. This does not establish exchange deposit credit.',
    })
  } catch {
    return res.status(503).json({ success: false, error: 'persisted-history-unavailable', message: 'Persisted receiver history is temporarily unavailable.' })
  }
})


function hasValidWatchlistAdminToken(req) {
  const configured = process.env.RECEIVER_WATCHLIST_ADMIN_TOKEN
  const authorization = req.headers.authorization
  if (typeof configured !== 'string' || configured.length < 32
    || typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false
  const supplied = Buffer.from(authorization.slice(7))
  const expected = Buffer.from(configured)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

// Watchlist changes are privileged: never allow anonymous callers to enroll
// arbitrary addresses into persistent polling. Configure a server-only token
// of at least 32 characters before using this administrative endpoint.
router.post('/tracked-wallets', async (req, res) => {
  if (!process.env.RECEIVER_WATCHLIST_ADMIN_TOKEN || process.env.RECEIVER_WATCHLIST_ADMIN_TOKEN.length < 32) {
    return res.status(503).json({ success: false, error: 'watchlist-registration-not-configured', message: 'Protected receiver registration is not configured on this server.' })
  }
  if (!hasValidWatchlistAdminToken(req)) {
    return res.status(401).json({ success: false, error: 'unauthorized', message: 'A valid watchlist administrator token is required.' })
  }
  const { network, address, displayLabel } = req.body || {}
  if (typeof network !== 'string' || !Object.hasOwn(networks, network)) {
    return res.status(400).json({ success: false, error: 'invalid-network', message: 'network must be mainnet, shasta, or nile.' })
  }
  if (typeof address !== 'string' || !addressPattern.test(address)) {
    return res.status(400).json({ success: false, error: 'invalid-address', message: 'Provide a valid TRON Base58 receiver address.' })
  }
  if (displayLabel !== undefined && (typeof displayLabel !== 'string' || displayLabel.trim().length > 80)) {
    return res.status(400).json({ success: false, error: 'invalid-display-label', message: 'displayLabel must be a string no longer than 80 characters.' })
  }
  try {
    const { TronWeb } = await import('tronweb')
    const tronWeb = new TronWeb({ fullHost: networks[network] })
    if (!tronWeb.isAddress(address)) return res.status(400).json({ success: false, error: 'invalid-address' })
    const result = await registerTrackedWallet({
      network,
      address,
      displayLabel: typeof displayLabel === 'string' ? displayLabel.trim() || null : null,
    })
    if (!result.success) return res.status(503).json({ success: false, error: 'watchlist-registration-unavailable', reason: result.reason })
    return res.status(result.created ? 201 : 200).json({
      success: true,
      status: result.created ? 'receiver-registered-for-monitoring' : 'receiver-already-registered',
      network,
      address,
      created: result.created,
      monitoring: 'pending-worker-schedule',
      note: 'Registration adds this address to the server watchlist only. Monitoring runs only when the separately configured worker is enabled and scheduled.',
    })
  } catch {
    return res.status(503).json({ success: false, error: 'watchlist-registration-unavailable', message: 'Could not register this receiver for monitoring.' })
  }
})

// Read-only incoming TRC-20 indexer feed. Indexer rows are candidates only;
// they are not final settlement evidence until solidified transaction/receipt
// verification succeeds in the existing verification endpoint.
router.get('/receiver-history', async (req, res) => {
  const { network, address, contract, fingerprint } = req.query
  const limitValue = req.query.limit === undefined ? '20' : req.query.limit
  const limit = Number(limitValue)
  // TRONGrid supplies opaque pagination fingerprints. Bound and validate the
  // token before forwarding it; callers cannot choose an upstream URL.
  if (fingerprint !== undefined && (typeof fingerprint !== 'string'
    || fingerprint.length < 1 || fingerprint.length > 512
    || !/^[A-Za-z0-9_=-]+$/.test(fingerprint))) {
    return res.status(400).json({ success: false, error: 'invalid-fingerprint', message: 'fingerprint must be a valid bounded TRONGrid pagination token.' })
  }
  if (typeof network !== 'string' || !Object.hasOwn(networks, network)) {
    return res.status(400).json({ success: false, error: 'invalid-network', message: 'network must be mainnet, shasta, or nile.' })
  }
  if (typeof address !== 'string' || !addressPattern.test(address)) {
    return res.status(400).json({ success: false, error: 'invalid-address', message: 'Provide a valid TRON Base58 receiver address.' })
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    return res.status(400).json({ success: false, error: 'invalid-limit', message: 'limit must be an integer from 1 to 50.' })
  }
  try {
    const { TronWeb } = await import('tronweb')
    const tronWeb = new TronWeb({ fullHost: networks[network] })
    if (!tronWeb.isAddress(address)) return res.status(400).json({ success: false, error: 'invalid-address' })
    if (contract !== undefined && (typeof contract !== 'string' || !tronWeb.isAddress(contract))) {
      return res.status(400).json({ success: false, error: 'invalid-contract', message: 'contract must be a valid TRON Base58 token contract address.' })
    }
    const query = new URLSearchParams({
      only_confirmed: 'true',
      only_to: 'true',
      limit: String(limit),
      order_by: 'block_timestamp,desc',
    })
    if (typeof contract === 'string' && contract) query.set('contract_address', contract)
    if (typeof fingerprint === 'string') query.set('fingerprint', fingerprint)
    const headers = { accept: 'application/json' }
    if (process.env.TRONGRID_API_KEY) headers['TRON-PRO-API-KEY'] = process.env.TRONGRID_API_KEY
    const response = await fetch(`${networks[network]}/v1/accounts/${encodeURIComponent(address)}/transactions/trc20?${query.toString()}`, {
      headers,
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) {
      return res.status(502).json({ success: false, error: 'history-provider-unavailable', providerStatus: response.status, message: 'The selected network history indexer is unavailable; no empty history is implied.' })
    }
    const payload = await response.json()
    if (!Array.isArray(payload?.data)) throw new Error('invalid-indexer-response')
    const records = payload.data.map((item) => ({
      transactionId: item.transaction_id || item.txID || null,
      network,
      receiverAddress: item.to || address,
      senderAddress: item.from || null,
      tokenContract: item.token_info?.address || item.contract_address || null,
      tokenName: item.token_info?.name || null,
      tokenSymbol: item.token_info?.symbol || null,
      tokenDecimals: Number.isInteger(Number(item.token_info?.decimals)) ? Number(item.token_info.decimals) : null,
      amountBaseUnits: typeof item.value === 'string' || typeof item.value === 'number' ? String(item.value) : null,
      timestamp: Number.isFinite(Number(item.block_timestamp)) ? Number(item.block_timestamp) : null,
      eventIndex: item.event_index ?? item.eventIndex ?? null,
      indexedConfirmed: item.block_timestamp !== undefined,
      verificationStatus: 'indexed-candidate-awaiting-solidified-verification',
      verifiedOnChain: false,
    }))
    return res.json({
      success: true,
      status: 'indexed-candidates-not-finalized',
      network,
      address,
      contract: typeof contract === 'string' ? contract : null,
      count: records.length,
      nextFingerprint: payload?.meta?.fingerprint || null,
      records,
      source: 'TRONGrid confirmed TRC-20 history indexer',
      note: 'These indexed incoming records are candidates, not final settlement proof. Verify each transaction against the selected network solidified transaction body, receipt, exact contract and Transfer event before displaying it as fully verified. Wallet/exchange UI and exchange credit are controlled by the receiving platform.',
    })
  } catch {
    return res.status(502).json({ success: false, error: 'receiver-history-unavailable', message: 'Could not safely read incoming TRC-20 history from the selected network.' })
  }
})

export default router
