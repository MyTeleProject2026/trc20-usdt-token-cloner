import { access, readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { constants } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const SDK_PACKAGE = '@ripple/ripple-custody-client-lib-typescript'
const require = createRequire(import.meta.url)

export class RippleCustodyApiError extends Error {
  constructor(status, code = 'ripple-custody-sdk-error') {
    super(code)
    this.name = 'RippleCustodyApiError'
    this.status = status
    this.code = code
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
  const configFile = String(env.RC_CONFIG_FILE || path.resolve('config/ripple-custody.toml')).trim()
  const clientId = String(env.RC_CLIENT_ID || '').trim()
  const clientSecret = String(env.RC_CLIENT_SECRET || '').trim()
  let fileClientId = ''
  try { fileClientId = /^\s*client_id\s*=\s*[\"']([^\"']+)[\"']/m.exec(readFileSync(configFile, 'utf8'))?.[1]?.trim() || '' } catch { /* reported below as missing config */ }
  if (!clientId && !fileClientId) missing.push('RC_CLIENT_ID or client_id in config file')
  if (!clientSecret) missing.push('RC_CLIENT_SECRET')
  try { readFileSync(configFile, 'utf8') } catch { missing.push('RC_CONFIG_FILE (readable TOML required)') }
  return {
    configured: missing.length === 0,
    missing,
    configFile,
    authMode: 'client_credentials',
    network: String(env.RIPPLE_CUSTODY_NETWORK || 'unverified').trim(),
  }
}

async function loadSdk(sdkModule) {
  if (sdkModule) return sdkModule
  try { return await import(SDK_PACKAGE) }
  catch { throw new RippleCustodyApiError(503, 'ripple-custody-sdk-package-unavailable') }
}

export async function createRippleCustodyClient({ env = process.env, sdkModule } = {}) {
  const config = rippleCustodyConfiguration(env)
  if (!config.configured) throw new RippleCustodyApiError(503, 'ripple-custody-service-auth-not-configured')
  try {
    await access(config.configFile, constants.R_OK)
    const file = await readFile(config.configFile, 'utf8')
    const fileClientId = /^\s*client_id\s*=\s*["']([^"']+)["']/m.exec(file)?.[1]?.trim() || ''
    if (!String(env.RC_CLIENT_ID || fileClientId).trim()) {
      throw new RippleCustodyApiError(503, 'ripple-custody-service-client-id-missing')
    }
  } catch (error) {
    if (error instanceof RippleCustodyApiError) throw error
    throw new RippleCustodyApiError(503, 'ripple-custody-config-file-unavailable')
  }

  const sdk = await loadSdk(sdkModule)
  if (typeof sdk.loadConfiguration !== 'function' || typeof sdk.CustodyClient !== 'function') {
    throw new RippleCustodyApiError(503, 'ripple-custody-sdk-interface-unavailable')
  }

  let custody
  try {
    custody = new sdk.CustodyClient(sdk.loadConfiguration(config.configFile))
  } catch {
    throw new RippleCustodyApiError(503, 'ripple-custody-sdk-configuration-invalid')
  }

  const unsupported = async () => {
    throw new RippleCustodyApiError(501, 'ripple-custody-operation-not-exposed-by-approved-sdk-adapter')
  }
  const getDomains = async () => {
    try {
      const page = await custody.governance.domains.list({ limit: 100, autoPaginate: true })
      return Array.isArray(page) ? page : (page?.items || [])
    } catch {
      throw new RippleCustodyApiError(503, 'ripple-custody-domain-read-failed')
    }
  }
  const read = Object.freeze({
    getDomains,
    getDomain: async (id) => (await getDomains()).find((item) => item?.data?.id === id) || null,
    getVaults: unsupported, getOmnibus: unsupported, listTenants: unsupported,
    getTenant: unsupported, getDepositWallet: unsupported, getBalances: unsupported,
    getConfirmedBalance: unsupported, listIntents: unsupported, getIntent: unsupported,
    listSponsors: unsupported, getAccountSponsor: unsupported, listValidSponsors: unsupported,
    getOmnibusInternalTransfers: unsupported, listTransactions: unsupported,
    getTransaction: unsupported, listTransfers: unsupported, getTransfer: unsupported,
    listTransactionOrders: unsupported, getTransactionOrder: unsupported, listEvents: unsupported,
  })
  const disabled = async () => { throw new RippleCustodyWriteDisabledError() }
  const writes = Object.freeze({
    createOmnibus: disabled, createTenant: disabled, createDepositWallet: disabled,
    createInternalTransfer: disabled, createWithdrawal: disabled, proposeIntent: disabled,
    approveIntent: disabled, rejectIntent: disabled, createAccountSponsor: disabled,
    updateAccountSponsor: disabled, deleteAccountSponsor: disabled,
    addSponsoredAccounts: disabled, removeSponsoredAccount: disabled,
  })
  return Object.freeze({
    config: { configured: true, authMode: config.authMode, network: config.network },
    read, writes,
    close: async () => { if (typeof custody.close === 'function') await custody.close() },
  })
}
