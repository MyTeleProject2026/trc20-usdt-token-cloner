import { createHash, timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import { getWalletAuthSession } from '../database.mjs'
import { createRippleCustodyClient, rippleCustodyConfiguration, RippleCustodyApiError } from '../ripple-custody-client.mjs'
import { createBitpieAdapter } from '../bitpie-adapter.mjs'
import { allocateRestrictedTrxCredit, getRestrictedTrxCreditAccount } from '../ripple-custody-ledger.mjs'

function digest(value) { return createHash('sha256').update(value).digest('hex') }
function bearer(req) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get('authorization') || '')
  return match?.[1] || ''
}
function sameText(a, b) {
  const left = Buffer.from(String(a || ''))
  const right = Buffer.from(String(b || ''))
  return left.length === right.length && timingSafeEqual(left, right)
}
function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, private')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Vary', 'Authorization, Origin')
}

export function createRippleCustodyRouter({
  env = process.env,
  getSession = getWalletAuthSession,
  clientFactory = () => createRippleCustodyClient({ env }),
  creditAllocator = allocateRestrictedTrxCredit,
  creditReader = getRestrictedTrxCreditAccount,
} = {}) {
  const router = Router()
  const bitpie = createBitpieAdapter()

  async function ownerOnly(req, res, next) {
    noStore(res)
    const token = bearer(req)
    const origin = req.get('origin')
    if (!token || !origin) return res.status(401).json({ success: false, error: 'owner-session-required' })
    let lookup
    try { lookup = await getSession({ tokenHash: digest(token), origin, nowMs: Date.now() }) } catch { lookup = null }
    if (lookup?.success !== true) return res.status(503).json({ success: false, error: 'owner-session-storage-unavailable' })
    const session = lookup.session
    const ownerAddress = typeof env.OWNER_WALLET_ADDRESS === 'string' ? env.OWNER_WALLET_ADDRESS.trim() : ''
    if (!session || session.network !== 'mainnet' || session.origin !== origin || !sameText(session.address, ownerAddress)) {
      return res.status(401).json({ success: false, error: 'owner-session-invalid-or-expired' })
    }
    req.ownerAddress = session.address
    return next()
  }
  router.use(ownerOnly)

  router.get('/status', (_req, res) => {
    const config = rippleCustodyConfiguration(env)
    return res.json({
      success: true, provider: 'Ripple Custody', configured: config.configured,
      missing: config.missing, network: config.network,
      readOperationsEnabled: config.configured, mutationOperationsEnabled: false, realValueExecutionEnabled: false,
      bitpie: bitpie.capabilities,
      disclosures: [
        'Ripple Custody virtual-account balances are custody-provider accounting records, not Bitpie wallet balances.',
        'Tron Transfer restricted credits are separate internal ledger entries and are not actual TRX.',
        'Provider API connectivity is not proof of blockchain finality or recipient exchange credit.',
      ],
    })
  })
  router.get('/bitpie/capabilities', (_req, res) => res.json({ success: true, ...bitpie.capabilities }))
  router.post('/bitpie/validate-address', (req, res) => res.json({ success: true, ...bitpie.validateTronAddress(req.body?.address) }))

  router.get('/credits/:customerId', async (req, res) => {
    try { return res.json(await creditReader(req.params.customerId)) }
    catch { return res.status(503).json({ success: false, error: 'credit-ledger-unavailable' }) }
  })
  router.post('/credits/allocate', async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).some((key) => !['customerId', 'amountSun', 'idempotencyKey', 'reason'].includes(key))) {
      return res.status(400).json({ success: false, error: 'unexpected-fields' })
    }
    try {
      const result = await creditAllocator({ ...body, actorAddress: req.ownerAddress })
      const status = result.success ? (result.duplicate ? 200 : 201) : result.error === 'idempotency-conflict' ? 409 : 400
      return res.status(status).json(result)
    } catch { return res.status(503).json({ success: false, error: 'credit-ledger-unavailable' }) }
  })

  async function providerRead(res, operation) {
    try {
      const client = clientFactory()
      return res.json({ success: true, provider: 'Ripple Custody', data: await operation(client) })
    } catch (error) {
      const status = error instanceof RippleCustodyApiError ? error.status : 503
      return res.status(status).json({ success: false, error: error instanceof RippleCustodyApiError ? error.code : 'ripple-custody-read-failed' })
    }
  }

  router.get('/domains', (_req, res) => providerRead(res, (client) => client.read.getDomains()))
  router.get('/vaults', (_req, res) => providerRead(res, (client) => client.read.getVaults()))
  router.get('/domains/:domainId', (req, res) => providerRead(res, (client) => client.read.getDomain(req.params.domainId)))
  router.get('/domains/:domainId/omnibus', (req, res) => providerRead(res, (client) => client.read.getOmnibus(req.params.domainId)))
  router.get('/domains/:domainId/omnibus/:omnibusId/tenants', (req, res) => providerRead(res, (client) => client.read.listTenants(req.params.omnibusId, req.params.domainId)))
  router.get('/domains/:domainId/omnibus/:omnibusId/tenants/:tenantId', (req, res) => providerRead(res, (client) => client.read.getTenant(req.params.tenantId, req.params.omnibusId, req.params.domainId)))
  router.get('/domains/:domainId/omnibus/:omnibusId/tenants/:tenantId/deposit-wallet', (req, res) => providerRead(res, (client) => client.read.getDepositWallet(req.params.tenantId, req.params.omnibusId, req.params.domainId)))
  router.get('/domains/:domainId/accounts/:accountId/balances', (req, res) => providerRead(res, (client) => client.read.getBalances(req.params.accountId, req.params.domainId)))
  router.get('/domains/:domainId/accounts/:accountId/confirmed-balance/:tickerId', (req, res) => providerRead(res, (client) => client.read.getConfirmedBalance(req.params.accountId, req.params.tickerId, req.params.domainId)))
  router.get('/domains/:domainId/intents', (req, res) => providerRead(res, (client) => client.read.listIntents(req.params.domainId)))
  router.get('/domains/:domainId/intents/:intentId', (req, res) => providerRead(res, (client) => client.read.getIntent(req.params.intentId, req.params.domainId)))
  router.get('/domains/:domainId/sponsors', (req, res) => providerRead(res, (client) => client.read.listSponsors(req.params.domainId)))
  router.get('/domains/:domainId/accounts/:accountId/sponsor', (req, res) => providerRead(res, (client) => client.read.getAccountSponsor(req.params.accountId, req.params.domainId)))
  router.get('/domains/:domainId/sponsors/account/:accountId/valid-sponsors', (req, res) => providerRead(res, (client) => client.read.listValidSponsors(req.params.accountId, req.params.domainId)))
  router.get('/domains/:domainId/omnibus/:omnibusId/internal-transfers', (req, res) => providerRead(res, (client) => client.read.getOmnibusInternalTransfers(req.params.omnibusId, req.params.domainId)))


  // Mutation endpoints are present as explicit fail-closed responses so clients
  // cannot mistake an unimplemented provider write for a successful operation.
  const mutationDisabled = (_req, res) => res.status(503).json({
    success: false, error: 'ripple-custody-mutations-disabled',
    mutationEnabled: false, realValueExecutionEnabled: false,
  })
  router.post('/domains/:domainId/omnibus', mutationDisabled)
  router.post('/domains/:domainId/omnibus/:omnibusId/tenants', mutationDisabled)
  router.post('/domains/:domainId/omnibus/:omnibusId/tenants/:tenantId/deposit-wallet', mutationDisabled)
  router.post('/domains/:domainId/omnibus/:omnibusId/tenants/:tenantId/internal-transfers', mutationDisabled)
  router.post('/domains/:domainId/omnibus/:omnibusId/tenants/:tenantId/withdrawals', mutationDisabled)
  router.post('/intents', mutationDisabled)
  router.post('/intents/approve', mutationDisabled)
  router.post('/intents/reject', mutationDisabled)
  router.post('/domains/:domainId/account/:accountId/sponsor', mutationDisabled)
  router.put('/domains/:domainId/account/:accountId/sponsor', mutationDisabled)
  router.delete('/domains/:domainId/account/:accountId/sponsor', mutationDisabled)
  router.post('/domains/:domainId/account/:entityId/sponsored-accounts', mutationDisabled)

  return router
}
export default createRippleCustodyRouter()
