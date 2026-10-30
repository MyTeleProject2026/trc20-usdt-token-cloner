import { timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import { createSponsorOrganizationStore, isValidSponsorRegistryReference, isValidSponsorAccountInput } from '../sponsor-organizations.mjs'

const ORGANIZATION_DECISIONS = new Set(['under_review', 'verified', 'approved', 'suspended', 'revoked'])
const ACCOUNT_DECISIONS = new Set(['verified', 'suspended', 'revoked'])
const VERIFICATION_METHODS = new Set(['wallet-signature', 'custodial-provider-attestation', 'multisig-attestation', 'manual-independent-review'])

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Vary', 'Authorization')
}

function isAdmin(req, env) {
  const expectedValue = env.SPONSOR_ADMIN_API_TOKEN
  const header = req.get('authorization') || ''
  if (typeof expectedValue !== 'string' || expectedValue.length < 32 || !/^Bearer /.test(header)) return false
  const supplied = Buffer.from(header.slice(7))
  const expected = Buffer.from(expectedValue)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

function hasOnlyKeys(body, allowed) {
  return Boolean(body && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).every((key) => allowed.has(key)))
}

function validText(value, min, max) {
  return typeof value === 'string' && value.trim().length >= min && value.trim().length <= max
}

function resultStatus(reason) {
  if (reason === 'database-not-configured' || reason === 'database-unavailable') return 503
  if (reason?.endsWith('-not-found')) return 404
  if (reason?.includes('already-exists') || reason?.includes('already-registered')) return 409
  if (reason?.includes('status-transition') || reason?.includes('not-active')) return 409
  if (reason?.includes('evidence-required') || reason?.includes('agreement-reference-required')
    || reason?.includes('verification-required')) return 422
  return 400
}

export function createSponsorOrganizationRouter(options = {}) {
  const router = Router()
  const env = options.env ?? process.env
  const store = options.store ?? createSponsorOrganizationStore({ env })

  router.use((req, res, next) => {
    noStore(res)
    if (!isAdmin(req, env)) return res.status(401).json({ success: false, error: 'sponsor-admin-authorization-required' })
    return next()
  })

  router.get('/sponsorship/organizations', async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : null
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit)
    const result = await store.listOrganizations({ status, limit })
    if (!result.success) return res.status(resultStatus(result.reason)).json({ success: false, error: result.reason })
    return res.json({
      success: true, organizations: result.organizations,
      submissionEnabled: false, canSubmitSponsoredTransfer: false,
    })
  })

  router.post('/sponsorship/organizations', async (req, res) => {
    if (!hasOnlyKeys(req.body, new Set(['sponsorReference', 'legalName', 'displayName', 'jurisdictionCountryCode']))
      || !validText(req.body?.sponsorReference, 3, 100)
      || !validText(req.body?.legalName, 2, 160)
      || (req.body?.displayName !== undefined && !validText(req.body.displayName, 1, 120))
      || (req.body?.jurisdictionCountryCode !== undefined
        && (typeof req.body.jurisdictionCountryCode !== 'string' || !/^[A-Za-z]{2}$/.test(req.body.jurisdictionCountryCode.trim())))) {
      return res.status(400).json({ success: false, error: 'invalid-organization-request' })
    }
    const result = await store.createOrganization(req.body)
    if (!result.success) return res.status(resultStatus(result.reason)).json({ success: false, error: result.reason })
    return res.status(201).json({
      success: true, organization: result.organization,
      submissionEnabled: false, canSubmitSponsoredTransfer: false,
    })
  })

  router.post('/sponsorship/organizations/:organizationId/accounts', async (req, res) => {
    if (!hasOnlyKeys(req.body, new Set(['sponsorReference', 'network', 'role', 'address']))
      || !isValidSponsorAccountInput(req.body)) {
      return res.status(400).json({ success: false, error: 'invalid-sponsor-account-request' })
    }
    const result = await store.createAccount(req.params.organizationId, req.body)
    if (!result.success) return res.status(resultStatus(result.reason)).json({ success: false, error: result.reason })
    return res.status(201).json({
      success: true, account: result.account,
      submissionEnabled: false, canSubmitSponsoredTransfer: false,
    })
  })

  router.post('/sponsorship/organizations/:organizationId/review', async (req, res) => {
    const allowed = new Set(['decision', 'reviewReference', 'evidenceReference', 'verificationMethod', 'agreementReference'])
    if (!hasOnlyKeys(req.body, allowed)
      || !ORGANIZATION_DECISIONS.has(req.body?.decision)
      || !isValidSponsorRegistryReference(req.body?.reviewReference)
      || (req.body.decision === 'verified'
        && (!isValidSponsorRegistryReference(req.body.evidenceReference) || !VERIFICATION_METHODS.has(req.body.verificationMethod)))
      || (req.body.decision === 'approved' && !isValidSponsorRegistryReference(req.body.agreementReference))) {
      return res.status(400).json({ success: false, error: 'invalid-organization-review-request' })
    }
    const result = await store.reviewOrganization(req.params.organizationId, req.body)
    if (!result.success) return res.status(resultStatus(result.reason)).json({ success: false, error: result.reason })
    return res.json({
      success: true, organization: result.organization,
      submissionEnabled: false, canSubmitSponsoredTransfer: false,
    })
  })

  router.post('/sponsorship/organizations/:organizationId/accounts/:accountId/review', async (req, res) => {
    const allowed = new Set(['decision', 'reviewReference', 'evidenceReference', 'verificationMethod'])
    if (!hasOnlyKeys(req.body, allowed)
      || !ACCOUNT_DECISIONS.has(req.body?.decision)
      || !isValidSponsorRegistryReference(req.body?.reviewReference)
      || (req.body.decision === 'verified'
        && (!isValidSponsorRegistryReference(req.body.evidenceReference) || !VERIFICATION_METHODS.has(req.body.verificationMethod)))) {
      return res.status(400).json({ success: false, error: 'invalid-sponsor-account-review-request' })
    }
    const result = await store.reviewAccount(req.params.organizationId, req.params.accountId, req.body)
    if (!result.success) return res.status(resultStatus(result.reason)).json({ success: false, error: result.reason })
    return res.json({
      success: true, account: result.account,
      submissionEnabled: false, canSubmitSponsoredTransfer: false,
    })
  })

  return router
}

export default createSponsorOrganizationRouter()
