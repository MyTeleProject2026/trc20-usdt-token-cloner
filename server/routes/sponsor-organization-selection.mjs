import { createHash, timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import { Trx } from 'tronweb'
import { getWalletAuthSession } from '../database.mjs'
import { createSponsorOrganizationStore } from '../sponsor-organizations.mjs'
import { selectSponsorOrganizationPair } from '../sponsor-organization-selection.mjs'
import { reserveSponsorOrganizationPayoutIntent } from '../sponsor-organization-payout-intents.mjs'
import { isValidTronAddress } from '../tron-address.mjs'

function isAdmin(req, env) {
  const expectedValue = env.SPONSOR_ADMIN_API_TOKEN
  const header = req.get('authorization') || ''
  if (typeof expectedValue !== 'string' || expectedValue.length < 32 || !/^Bearer /.test(header)) return false
  const supplied = Buffer.from(header.slice(7))
  const expected = Buffer.from(expectedValue)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

function positiveUnits(value) {
  return typeof value === 'string' && /^[1-9][0-9]{0,77}$/.test(value)
}

export function createSponsorOrganizationSelectionRouter(options = {}) {
  const router = Router()
  const env = options.env ?? process.env
  const store = options.store ?? createSponsorOrganizationStore({ env })
  const selector = options.selector ?? selectSponsorOrganizationPair
  const reserveIntent = options.reserveIntent ?? reserveSponsorOrganizationPayoutIntent
  const readWalletSession = options.readWalletSession ?? getWalletAuthSession
  const verifyMessage = options.verifyMessage ?? ((message, signature) => Trx.verifyMessageV2(message, signature))

  router.get('/sponsorship/organizations/selection', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Vary', 'Authorization')
    if (!isAdmin(req, env)) {
      return res.status(401).json({ success: false, error: 'sponsor-admin-authorization-required' })
    }
    const { network, asset, tokenContract, amountBaseUnits, estimatedFeeSun } = req.query
    const normalizedContract = asset === 'TRX' ? null : tokenContract
    if (typeof network !== 'string' || typeof asset !== 'string'
      || typeof amountBaseUnits !== 'string' || !positiveUnits(amountBaseUnits)
      || typeof estimatedFeeSun !== 'string' || !positiveUnits(estimatedFeeSun)
      || (asset === 'TRX' ? tokenContract !== undefined : !isValidTronAddress(tokenContract))) {
      return res.status(400).json({ success: false, error: 'invalid-sponsor-selection-request' })
    }
    try {
      const result = await selector({
        store,
        env,
        network,
        asset,
        tokenContract: normalizedContract,
        amountBaseUnits,
        estimatedFeeSun,
      })
      const code = result.success ? 200
        : result.reason?.includes('truncated') ? 503
          : result.reason?.includes('unavailable') ? 503
            : result.reason?.startsWith('no-') ? 200 : 422
      return res.status(code).json(result)
    } catch {
      return res.status(503).json({
        success: false,
        error: 'sponsor-organization-selection-unavailable',
        canSubmitSponsoredTransfer: false,
        submissionEnabled: false,
      })
    }
  })

  router.post('/sponsorship/organizations/payout-intents', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Vary', 'Authorization')
    if (!isAdmin(req, env)) {
      return res.status(401).json({ success: false, error: 'sponsor-admin-authorization-required' })
    }
    const allowed = new Set([
      'idempotencyKey', 'network', 'asset', 'tokenContract', 'receiverAddress',
      'amountBaseUnits', 'feeCapSun', 'principalBudgetLinkId', 'feeBudgetLinkId',
    ])
    const body = req.body || {}
    if (Object.keys(body).some((key) => !allowed.has(key))
      || typeof body.idempotencyKey !== 'string'
      || typeof body.network !== 'string'
      || typeof body.asset !== 'string'
      || (body.tokenContract !== undefined && typeof body.tokenContract !== 'string')
      || typeof body.receiverAddress !== 'string' || !isValidTronAddress(body.receiverAddress)
      || !positiveUnits(body.amountBaseUnits) || !positiveUnits(body.feeCapSun)
      || typeof body.principalBudgetLinkId !== 'string' || !/^[1-9][0-9]{0,17}$/.test(body.principalBudgetLinkId)
      || typeof body.feeBudgetLinkId !== 'string' || !/^[1-9][0-9]{0,17}$/.test(body.feeBudgetLinkId)) {
      return res.status(400).json({ success: false, error: 'invalid-payout-intent-request' })
    }
    try {
      const result = await reserveIntent({
        store, env,
        input: {
          idempotencyKey: body.idempotencyKey,
          network: body.network,
          asset: body.asset,
          tokenContract: body.tokenContract ?? null,
          receiverAddress: body.receiverAddress,
          amountBaseUnits: body.amountBaseUnits,
          feeCapSun: body.feeCapSun,
          principalLinkId: body.principalBudgetLinkId,
          feeLinkId: body.feeBudgetLinkId,
        },
        readRoleFunding: options.readRoleFunding,
      })
      if (!result.success) {
        const reason = result.reason || 'dual-sponsor-reservation-unavailable'
        const status = reason.includes('conflict') ? 409
          : reason.includes('unavailable') || reason.includes('failed') || reason.includes('truncated') ? 503
            : reason === 'invalid-payout-intent' ? 400 : 422
        return res.status(status).json({ success: false, error: reason, ...result })
      }
      return res.status(result.duplicate ? 200 : 201).json(result)
    } catch {
      return res.status(503).json({
        success: false, error: 'dual-sponsor-reservation-unavailable',
        transactionSubmitted: false, canSubmitSponsoredTransfer: false, submissionEnabled: false,
      })
    }
  })

  const isAllowedWalletOrigin = (origin) => {
    if (typeof origin !== 'string' || !origin) return false
    const configured = [env.FRONTEND_ORIGIN, env.PACKAGED_APP_ORIGINS, env.OKX_UI_ORIGIN]
      .filter((value) => typeof value === 'string')
      .flatMap((value) => value.split(','))
    return configured.some((value) => {
      try {
        const parsed = new URL(value.trim())
        const normalized = parsed.protocol === 'tronstudio:' && parsed.host.toLowerCase() === 'app'
          ? 'tronstudio://app'
          : ['https:', 'http:'].includes(parsed.protocol) ? parsed.origin : ''
        return normalized === origin
      } catch {
        return false
      }
    })
  }

  const resolveWalletSession = async (req) => {
    const origin = req.get('origin')
    const header = req.get('authorization') || ''
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header)
    if (!match || !isAllowedWalletOrigin(origin)) return null
    try {
      const result = await readWalletSession({
        tokenHash: createHash('sha256').update(match[1]).digest('hex'),
        origin,
        nowMs: Date.now(),
      })
      if (result?.success !== true || !result.session
        || result.session.origin !== origin || result.session.expiresAt <= Date.now()) return null
      return result.session
    } catch {
      return null
    }
  }

  router.post('/sponsorship/payout-intents/:intentId/authorization-challenges', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Vary', 'Origin, Authorization')
    const body = req.body || {}
    if (Object.keys(body).some((key) => key !== 'role')
      || !['asset-principal', 'network-fee'].includes(body.role)) {
      return res.status(400).json({ success: false, error: 'invalid-sponsor-authorization-role' })
    }
    const session = await resolveWalletSession(req)
    if (!session) {
      return res.status(401).json({ success: false, error: 'matching-sponsor-wallet-session-required' })
    }
    const result = await store.createPayoutAuthorizationChallenge(req.params.intentId, body.role, {
      sessionAddress: session.address,
      sessionNetwork: session.network,
    })
    if (!result.success) {
      const reason = result.reason || 'sponsor-authorization-challenge-unavailable'
      const status = reason === 'payout-intent-not-found' ? 404
        : reason.includes('rate-limited') ? 429
          : reason.includes('database') || reason.includes('unavailable') ? 503
            : reason.includes('wallet-session') ? 403
              : reason.includes('already-authorized') ? 409 : 422
      return res.status(status).json({ ...result, canSubmitSponsoredTransfer: false, submissionEnabled: false })
    }
    return res.status(201).json({
      ...result,
      canSubmitSponsoredTransfer: false,
      submissionEnabled: false,
      transactionSubmitted: false,
    })
  })

  router.post('/sponsorship/payout-intents/:intentId/authorize', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Vary', 'Origin, Authorization')
    const body = req.body || {}
    if (Object.keys(body).some((key) => !['role', 'nonce', 'signature'].includes(key))
      || !['asset-principal', 'network-fee'].includes(body.role)
      || typeof body.nonce !== 'string' || !/^[0-9a-f]{48,128}$/i.test(body.nonce)
      || typeof body.signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(body.signature)) {
      return res.status(400).json({ success: false, error: 'invalid-sponsor-authorization-payload' })
    }
    const session = await resolveWalletSession(req)
    if (!session) {
      return res.status(401).json({ success: false, error: 'matching-sponsor-wallet-session-required' })
    }
    const consumed = await store.consumePayoutAuthorizationChallenge(
      req.params.intentId, body.role, body.nonce,
      { sessionAddress: session.address, sessionNetwork: session.network },
    )
    if (!consumed?.success) {
      const reason = consumed?.reason || 'sponsor-authorization-challenge-unavailable'
      const status = reason.includes('not-found') || reason.includes('consumed') ? 409
        : reason.includes('database') || reason.includes('unavailable') ? 503
          : reason.includes('expired') ? 410
            : 403
      return res.status(status).json({ success: false, error: reason, canSubmitSponsoredTransfer: false })
    }

    let recoveredAddress
    try {
      recoveredAddress = await verifyMessage(consumed.authorization.message, body.signature)
    } catch {
      return res.status(401).json({
        success: false, error: 'sponsor-authorization-signature-invalid',
        challengeConsumed: true, canSubmitSponsoredTransfer: false,
      })
    }
    if (recoveredAddress !== consumed.authorization.sponsorAddress
      || recoveredAddress !== session.address) {
      return res.status(401).json({
        success: false, error: 'sponsor-authorization-signature-address-mismatch',
        challengeConsumed: true, canSubmitSponsoredTransfer: false,
      })
    }
    const signatureHash = createHash('sha256').update(body.signature).digest('hex')
    const recorded = await store.recordPayoutAuthorization({
      intentId: req.params.intentId,
      role: body.role,
      challengeId: consumed.authorization.challengeId,
      intentDigest: consumed.authorization.intentDigest,
      recoveredAddress,
      signatureHash,
      messageHash: consumed.authorization.messageHash,
    })
    if (!recorded?.success) {
      const reason = recorded?.reason || 'sponsor-payout-authorization-record-unavailable'
      const status = reason.includes('already-authorized') ? 409
        : reason.includes('not-found') ? 404
          : reason.includes('database') || reason.includes('unavailable') ? 503 : 422
      return res.status(status).json({ ...recorded, error: reason, canSubmitSponsoredTransfer: false })
    }
    return res.json({
      ...recorded,
      transactionAuthorizationVerified: false,
      canSubmitSponsoredTransfer: false,
      submissionEnabled: false,
      transactionSubmitted: false,
      userFundedFallbackAllowed: false,
      note: 'Both sponsor owners may have approved this exact allocation, but this is not transaction authorization. Transaction-specific fee verification, signed transaction validation, and a separate submission review remain required.',
    })
  })

  router.post('/sponsorship/payout-intents/:intentId/cancel', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Vary', 'Authorization')
    if (!isAdmin(req, env)) {
      return res.status(401).json({ success: false, error: 'sponsor-admin-authorization-required' })
    }
    if (Object.keys(req.body || {}).some((key) => key !== 'reviewReference')
      || typeof req.body?.reviewReference !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,159}$/.test(req.body.reviewReference)) {
      return res.status(400).json({ success: false, error: 'invalid-payout-intent-cancellation' })
    }
    const result = await store.cancelPayoutIntent(req.params.intentId, req.body.reviewReference)
    if (!result.success) {
      const status = result.reason === 'invalid-payout-intent-cancellation' ? 400
        : result.reason === 'payout-intent-not-found' ? 404 : 503
      return res.status(status).json(result)
    }
    return res.json({
      ...result,
      canSubmitSponsoredTransfer: false,
      submissionEnabled: false,
      transactionSubmitted: false,
    })
  })

  router.post('/sponsorship/payout-intents/expire', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Vary', 'Authorization')
    if (!isAdmin(req, env)) {
      return res.status(401).json({ success: false, error: 'sponsor-admin-authorization-required' })
    }
    if (Object.keys(req.body || {}).some((key) => key !== 'limit')
      || (req.body?.limit !== undefined && (!Number.isInteger(req.body.limit) || req.body.limit < 1 || req.body.limit > 500))) {
      return res.status(400).json({ success: false, error: 'invalid-expiry-request' })
    }
    const result = await store.expirePayoutIntents({ limit: req.body?.limit ?? 100 })
    return res.status(result.success ? 200 : 503).json({
      ...result, canSubmitSponsoredTransfer: false, submissionEnabled: false,
    })
  })

  return router
}

export default createSponsorOrganizationSelectionRouter()
