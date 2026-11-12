const DEFAULT_TIMEOUT_MS = 12_000

export class RippleCustodyApiError extends Error {
  constructor(status, code = 'ripple-custody-provider-error') {
    super(code); this.name = 'RippleCustodyApiError'; this.status = status; this.code = code
  }
}
export class RippleCustodyWriteDisabledError extends Error {
  constructor() {
    super('ripple-custody-value-mutations-disabled')
    this.name = 'RippleCustodyWriteDisabledError'
    this.code = 'ripple-custody-value-mutations-disabled'
  }
}
export function rippleCustodyConfiguration(env = process.env) {
  const missing = []
  const raw = typeof env.RIPPLE_CUSTODY_API_BASE === 'string' ? env.RIPPLE_CUSTODY_API_BASE.trim().replace(/\/+$/, '') : ''
  let apiBase = ''
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error()
    apiBase = url.origin
  } catch { missing.push('RIPPLE_CUSTODY_API_BASE (HTTPS origin required)') }
  const token = typeof env.RIPPLE_CUSTODY_BEARER_TOKEN === 'string' ? env.RIPPLE_CUSTODY_BEARER_TOKEN.trim() : ''
  const domainId = typeof env.RIPPLE_CUSTODY_DOMAIN_ID === 'string' ? env.RIPPLE_CUSTODY_DOMAIN_ID.trim() : ''
  if (!token) missing.push('RIPPLE_CUSTODY_BEARER_TOKEN')
  if (!domainId) missing.push('RIPPLE_CUSTODY_DOMAIN_ID')
  return {
    configured: missing.length === 0, missing, apiBase, token, domainId,
    omnibusId: String(env.RIPPLE_CUSTODY_OMNIBUS_ID || '').trim(),
    tickerId: String(env.RIPPLE_CUSTODY_TRX_TICKER_ID || '').trim(),
    ledgerId: String(env.RIPPLE_CUSTODY_TRON_LEDGER_ID || '').trim(),
    network: String(env.RIPPLE_CUSTODY_NETWORK || 'unverified').trim(),
  }
}
function encode(value) { return encodeURIComponent(String(value)) }
function validPath(path) { return typeof path === 'string' && path.startsWith('/v1/') && !path.includes('..') && !path.includes('#') }

export function createRippleCustodyClient({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const config = rippleCustodyConfiguration(env)
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.')
  async function request(method, path) {
    if (!config.configured) throw new RippleCustodyApiError(503, 'ripple-custody-not-configured')
    if (!validPath(path)) throw new TypeError('Unsupported Ripple Custody API path.')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(config.apiBase + path, {
        method, headers: { authorization: 'Bearer ' + config.token, accept: 'application/json' }, signal: controller.signal,
      })
      const raw = await response.text()
      let payload = null
      if (raw) { try { payload = JSON.parse(raw) } catch { throw new RippleCustodyApiError(response.status, 'ripple-custody-invalid-json-response') } }
      if (!response.ok) throw new RippleCustodyApiError(response.status, 'ripple-custody-provider-rejected-request')
      return payload
    } catch (error) {
      if (error instanceof RippleCustodyApiError) throw error
      throw new RippleCustodyApiError(503, error?.name === 'AbortError' ? 'ripple-custody-timeout' : 'ripple-custody-unreachable')
    } finally { clearTimeout(timer) }
  }
  const read = Object.freeze({
    getDomains: () => request('GET', '/v1/domains'),
    getDomain: (id = config.domainId) => request('GET', '/v1/domains/' + encode(id)),
    getVaults: () => request('GET', '/v1/vaults'),
    getOmnibus: (domain = config.domainId) => request('GET', '/v1/domains/' + encode(domain) + '/omnibus'),
    listTenants: (omnibus = config.omnibusId, domain = config.domainId) => request('GET', '/v1/domains/' + encode(domain) + '/omnibus/' + encode(omnibus) + '/tenants'),
    getTenant: (tenant, omnibus = config.omnibusId, domain = config.domainId) => request('GET', '/v1/domains/' + encode(domain) + '/omnibus/' + encode(omnibus) + '/tenants/' + encode(tenant)),
    getDepositWallet: (tenant, omnibus = config.omnibusId, domain = config.domainId) => request('GET', '/v1/domains/' + encode(domain) + '/omnibus/' + encode(omnibus) + '/tenants/' + encode(tenant) + '/deposit-wallet'),
    getBalances: (account, domain = config.domainId) => request('GET', '/v1/domains/' + encode(domain) + '/accounts/' + encode(account) + '/balances'),
    getConfirmedBalance: (account, ticker = config.tickerId, domain = config.domainId) => request('GET', '/v1/domains/' + encode(domain) + '/accounts/' + encode(account) + '/confirmed-balance/' + encode(ticker)),
    listIntents: (domain = config.domainId) => request('GET', '/v1/domains/' + encode(domain) + '/intents'),
    getIntent: (intent, domain = config.domainId) => request('GET', '/v1/domains/' + encode(domain) + '/intents/' + encode(intent)),
    listSponsors: (domain = config.domainId) => request('GET', '/v1/domains/' + encode(domain) + '/sponsors'),
    getAccountSponsor: (account, domain = config.domainId) => request('GET', '/v1/domains/' + encode(domain) + '/account/' + encode(account) + '/sponsor'),
    listValidSponsors: (account, domain = config.domainId) => request('GET', '/v1/domains/' + encode(domain) + '/sponsors/account/' + encode(account) + '/valid-sponsors'),
    getOmnibusInternalTransfers: (omnibus = config.omnibusId, domain = config.domainId) => request('GET', '/v1/domains/' + encode(domain) + '/omnibus/' + encode(omnibus) + '/internal-transfers'),
  })
  const disabled = async () => { throw new RippleCustodyWriteDisabledError() }
  const writes = Object.freeze({
    createOmnibus: disabled, createTenant: disabled, createDepositWallet: disabled,
    createInternalTransfer: disabled, createWithdrawal: disabled, proposeIntent: disabled,
    approveIntent: disabled, rejectIntent: disabled, createAccountSponsor: disabled,
    updateAccountSponsor: disabled, deleteAccountSponsor: disabled,
    addSponsoredAccounts: disabled, removeSponsoredAccount: disabled,
  })
  return Object.freeze({ config: { ...config, token: undefined }, read, writes })
}
