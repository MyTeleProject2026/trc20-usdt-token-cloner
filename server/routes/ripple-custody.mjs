import { createHash, timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import { getWalletAuthSession } from '../database.mjs'
import { createRippleCustodyClient, rippleCustodyConfiguration, RippleCustodyApiError } from '../ripple-custody-client.mjs'
import { createBitpieAdapter } from '../bitpie-adapter.mjs'
import { allocateRestrictedTrxCredit, getRestrictedTrxCreditAccount } from '../ripple-custody-ledger.mjs'
import { isValidTronAddress } from '../tron-address.mjs'

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
  // Customer self-service is deliberately mounted before the owner-only guard.
  // It requires a separate signed TRON wallet session and reads only that wallet's own address-keyed ledger account.
  router.get('/credits/me', async (req, res) => {
    noStore(res)
    const token = bearer(req)
    const origin = req.get('origin')
    if (!token || !origin) return res.status(401).json({ success: false, error: 'customer-wallet-session-required' })
    let lookup
    try { lookup = await getSession({ tokenHash: digest(token), origin, nowMs: Date.now() }) } catch { lookup = null }
    if (lookup?.success !== true) return res.status(503).json({ success: false, error: 'customer-session-storage-unavailable' })
    const session = lookup.session
    if (!session || session.network !== 'mainnet' || session.origin !== origin || !isValidTronAddress(session.address)) {
      return res.status(401).json({ success: false, error: 'customer-wallet-session-invalid-or-expired' })
    }
    try { return res.json(await creditReader(session.address)) }
    catch { return res.status(503).json({ success: false, error: 'credit-ledger-unavailable' }) }
  })

  router.use(ownerOnly)

  router.get('/status', (_req, res) => {
    const config = rippleCustodyConfiguration(env)
    return res.json({
      success: true, provider: 'Ripple Custody', configured: config.configured,
      missing: config.missing, authMode: config.authMode, network: config.network,
      readOperationsEnabled: config.configured && config.sdkAvailable, sdkAvailable: config.sdkAvailable, mutationOperationsEnabled: false, realValueExecutionEnabled: false,
      sdk: 'official-typescript-sdk',
      bitpie: bitpie.capabilities,
      disclosures: [
        'Ripple Custody virtual-account balances are custody-provider accounting records, not Bitpie wallet balances.',
        'Tron Transfer restricted credits are separate internal ledger entries and are not actual TRX.',
        'Provider API connectivity is not proof of blockchain finality or recipient exchange credit.',
        'The configured PEM key is not used for client-credentials authentication; service tokens identify a service caller.',
        'Only the SDK-backed domain-list read is currently implemented; other provider reads remain unavailable until mapped to documented SDK methods.',
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
    let client
    try {
      client = await clientFactory()
      const data = await operation(client)
      return res.json({ success: true, provider: 'Ripple Custody', data })
    } catch (error) {
      const status = error instanceof RippleCustodyApiError ? error.status : 503
      return res.status(status).json({ success: false, error: error instanceof RippleCustodyApiError ? error.code : 'ripple-custody-read-failed' })
    } finally {
      try { await client?.close?.() } catch { /* never expose SDK shutdown details */ }
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
  router.get('/domains/:domainId/transactions', (req, res) => providerRead(res, (client) => client.read.listTransactions(req.params.domainId)))
  router.get('/domains/:domainId/transactions/transfers', (req, res) => providerRead(res, (client) => client.read.listTransfers(req.params.domainId)))
  router.get('/domains/:domainId/transactions/transfers/:transferId', (req, res) => providerRead(res, (client) => client.read.getTransfer(req.params.transferId, req.params.domainId)))
  router.get('/domains/:domainId/transactions/orders', (req, res) => providerRead(res, (client) => client.read.listTransactionOrders(req.params.domainId)))
  router.get('/domains/:domainId/transactions/orders/:orderId', (req, res) => providerRead(res, (client) => client.read.getTransactionOrder(req.params.orderId, req.params.domainId)))
  router.get('/domains/:domainId/transactions/:transactionId', (req, res) => providerRead(res, (client) => client.read.getTransaction(req.params.transactionId, req.params.domainId)))
  router.get('/domains/:domainId/events', (req, res) => providerRead(res, (client) => client.read.listEvents(req.params.domainId)))

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
