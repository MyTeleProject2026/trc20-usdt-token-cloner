import { timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import { createSponsorOrganizationStore } from '../sponsor-organizations.mjs'
import { selectSponsorOrganizationPair } from '../sponsor-organization-selection.mjs'

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
      || (asset === 'TRX' ? tokenContract !== undefined : typeof tokenContract !== 'string')) {
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
  return router
}

export default createSponsorOrganizationSelectionRouter()
