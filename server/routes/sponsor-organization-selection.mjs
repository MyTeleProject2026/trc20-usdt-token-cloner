import { timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
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
