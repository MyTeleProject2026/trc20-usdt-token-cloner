import { TronWeb } from 'tronweb'
import { tatumProviderFetch } from './tatum-provider-fetch.mjs'

const MAINNET = Object.freeze({
  host: 'https://api.trongrid.io',
  tatumHost: 'https://tron-mainnet.gateway.tatum.io',
})
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const UINT = /^(0|[1-9][0-9]{0,77})$/
const MAX_DELEGATORS = 10

function integer(value, fallback = '0') {
  const raw = value ?? fallback
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return String(raw)
  if (typeof raw === 'string' && UINT.test(raw)) return raw
  return null
}

function providerCategory(payload) {
  const text = [payload?.Error, payload?.error, payload?.message, payload?.code]
    .filter((v) => typeof v === 'string').join(' ').toLowerCase()
  if (/rate.?limit|too many requests|quota/.test(text)) return 'rate-limited'
  if (/not found|does not exist|unknown account/.test(text)) return 'account-not-found'
  if (/not support|not found.*method|unknown method/.test(text)) return 'endpoint-not-supported'
  return 'node-error-response'
}

/**
 * Mainnet-only, read-only resource reader. It queries real TRON FullNode APIs
 * through authenticated TRONGrid/Tatum when configured, with public TRONGrid
 * as a read-only fallback. It never creates, signs, or broadcasts a transaction.
 */
export function createFreeDelegationResourceReader({
  env = process.env,
  fetchImpl = tatumProviderFetch,
  addressValidator = (address) => TronWeb.isAddress(address),
  timeoutMs = 8000,
} = {}) {
  const cache = new Map()
  const inFlight = new Map()

  async function readProvider(provider, path, body, stage) {
    let response
    try {
      response = await fetchImpl(provider.host + path, {
        method: 'POST',
        redirect: 'error',
        headers: provider.headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      const error = new Error('provider-unreachable')
      error.category = 'provider-unreachable'
      error.stage = stage
      throw error
    }
    if (!response?.ok) {
      const error = new Error('provider-http-error')
      error.category = response?.status === 429 ? 'rate-limited' : 'provider-http-error'
      error.httpStatus = Number.isInteger(response?.status) ? response.status : undefined
      error.stage = stage
      throw error
    }
    let payload
    try { payload = await response.json() } catch {
      const error = new Error('provider-invalid-json')
      error.category = 'invalid-json'
      error.stage = stage
      throw error
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || payload.Error || payload.error || payload.result?.result === false) {
      const error = new Error('provider-node-error')
      error.category = providerCategory(payload)
      error.stage = stage
      throw error
    }
    return payload
  }

  async function post(path, body, stage) {
    const tronGridKey = typeof env.TRONGRID_API_KEY === 'string' ? env.TRONGRID_API_KEY.trim() : ''
    const tatumKey = typeof env.TATUM_API_KEY === 'string' ? env.TATUM_API_KEY.trim() : ''
    const providers = [
      ...(tronGridKey ? [{ name: 'TRONGrid', host: MAINNET.host, headers: { 'content-type': 'application/json', 'TRON-PRO-API-KEY': tronGridKey } }] : []),
      ...(tatumKey ? [{ name: 'Tatum', host: MAINNET.tatumHost, headers: { 'content-type': 'application/json', 'x-api-key': tatumKey } }] : []),
      ...(!tronGridKey ? [{ name: 'TRONGrid public', host: MAINNET.host, headers: { 'content-type': 'application/json' } }] : []),
    ]
    if (!providers.length) throw Object.assign(new Error('provider-credentials-missing'), { category: 'provider-credentials-missing', stage })
    let lastError
    for (const provider of providers) {
      try {
        const payload = await readProvider(provider, path, body, stage)
        return { payload, provider: provider.name }
      } catch (error) { lastError = error }
    }
    throw lastError ?? Object.assign(new Error('provider-unavailable'), { category: 'provider-unavailable', stage })
  }

  async function readFresh(address) {
    if (typeof address !== 'string' || !ADDRESS_PATTERN.test(address) || !addressValidator(address)) {
      return { success: false, network: 'mainnet', status: 'invalid-mainnet-address', resourceRead: false }
    }
    try {
      const resourceResult = await post('/wallet/getaccountresource', { address, visible: true }, 'account-resource')
      const indexResult = await post('/walletsolidity/getdelegatedresourceaccountindexv2', { value: address, visible: true }, 'delegation-index')
      const resources = resourceResult.payload
      const index = indexResult.payload
      const fields = {
        energyLimit: integer(resources.EnergyLimit),
        energyUsed: integer(resources.EnergyUsed),
        bandwidthLimit: integer(resources.NetLimit),
        bandwidthUsed: integer(resources.NetUsed),
        freeBandwidthLimit: integer(resources.freeNetLimit),
        freeBandwidthUsed: integer(resources.freeNetUsed),
      }
      if (Object.values(fields).some((value) => value === null)
        || BigInt(fields.energyUsed) > BigInt(fields.energyLimit)
        || BigInt(fields.bandwidthUsed) > BigInt(fields.bandwidthLimit)
        || BigInt(fields.freeBandwidthUsed) > BigInt(fields.freeBandwidthLimit)) {
        throw Object.assign(new Error('invalid-resource-response'), { category: 'invalid-resource-response', stage: 'account-resource' })
      }
      const fromAccounts = Array.isArray(index.fromAccounts) ? index.fromAccounts : null
      const toAccounts = Array.isArray(index.toAccounts) ? index.toAccounts : null
      if (!fromAccounts || !toAccounts) {
        throw Object.assign(new Error('invalid-delegation-index'), { category: 'invalid-delegation-index', stage: 'delegation-index' })
      }
      const delegators = [...new Set(fromAccounts.filter((value) => typeof value === 'string' && ADDRESS_PATTERN.test(value)))].slice(0, MAX_DELEGATORS)
      const records = []
      const providersUsed = new Set([resourceResult.provider, indexResult.provider])
      for (const delegator of delegators) {
        const detail = await post('/walletsolidity/getdelegatedresourcev2', {
          fromAddress: delegator, toAddress: address, visible: true,
        }, 'delegation-detail')
        providersUsed.add(detail.provider)
        const entries = Array.isArray(detail.payload.delegatedResource)
          ? detail.payload.delegatedResource
          : Array.isArray(detail.payload.delegated_resource) ? detail.payload.delegated_resource : []
        for (const entry of entries) {
          const energyStakeSun = integer(entry.frozen_balance_for_energy)
          const bandwidthStakeSun = integer(entry.frozen_balance_for_bandwidth)
          if (energyStakeSun === null || bandwidthStakeSun === null) {
            throw Object.assign(new Error('invalid-delegation-detail'), { category: 'invalid-delegation-detail', stage: 'delegation-detail' })
          }
          if (BigInt(energyStakeSun) > 0n || BigInt(bandwidthStakeSun) > 0n) {
            records.push({
              delegator,
              energyStakeSun,
              bandwidthStakeSun,
              energyExpireTime: integer(entry.expire_time_for_energy, '0'),
              bandwidthExpireTime: integer(entry.expire_time_for_bandwidth, '0'),
            })
          }
        }
      }
      const energyAvailable = (BigInt(fields.energyLimit) - BigInt(fields.energyUsed)).toString()
      const freeBandwidthAvailable = (BigInt(fields.freeBandwidthLimit) - BigInt(fields.freeBandwidthUsed)).toString()
      const stakedBandwidthAvailable = (BigInt(fields.bandwidthLimit) - BigInt(fields.bandwidthUsed)).toString()
      return {
        success: true,
        network: 'mainnet',
        status: 'mainnet-resource-snapshot-read',
        address,
        checkedAt: new Date().toISOString(),
        source: [...providersUsed].join(' + '),
        resourceRead: true,
        resources: {
          energyAvailable,
          energyLimit: fields.energyLimit,
          energyUsed: fields.energyUsed,
          freeBandwidthAvailable,
          freeBandwidthLimit: fields.freeBandwidthLimit,
          freeBandwidthUsed: fields.freeBandwidthUsed,
          stakedOrDelegatedBandwidthAvailable: stakedBandwidthAvailable,
          stakedOrDelegatedBandwidthLimit: fields.bandwidthLimit,
          stakedOrDelegatedBandwidthUsed: fields.bandwidthUsed,
        },
        inboundDelegations: {
          count: records.length,
          records,
          truncated: fromAccounts.length > MAX_DELEGATORS,
        },
        policy: {
          mode: 'free-delegation',
          walletApprovalRequired: true,
          walletAddress: address,
          network: 'mainnet',
          sponsorAccountConfigured: false,
          paidRentalEnabled: false,
          paidFallbackEnabled: false,
          automaticDelegationEnabled: false,
          protocolFreeEnergyQuota: '0',
          freeBandwidthIsProtocolQuota: true,
          freeEnergyProvider: 'not-configured',
          freeEnergyProviderStatus: 'no-verified-free-delegation-api',
          note: 'Energy has no protocol free quota. Available Energy is the live aggregate on-chain amount; incoming delegation records are listed separately. No provider is assumed to give Energy for free.',
        },
        transactionActions: { unsignedTransactionCreated: false, walletSignatureRequested: false, transactionBroadcast: false },
      }
    } catch (error) {
      return {
        success: false,
        network: 'mainnet',
        status: 'resource-read-unavailable',
        resourceRead: false,
        ...(Number.isInteger(error?.httpStatus) ? { providerStatus: error.httpStatus } : {}),
        failureStage: typeof error?.stage === 'string' ? error.stage : 'provider-read',
        providerResponseCategory: typeof error?.category === 'string' ? error.category : 'provider-unavailable',
        policy: {
          mode: 'free-delegation',
          walletApprovalRequired: true,
          network: 'mainnet',
          sponsorAccountConfigured: false,
          paidRentalEnabled: false,
          paidFallbackEnabled: false,
          automaticDelegationEnabled: false,
          protocolFreeEnergyQuota: '0',
        },
        transactionActions: { unsignedTransactionCreated: false, walletSignatureRequested: false, transactionBroadcast: false },
      }
    }
  }

  return async function readFreeDelegationResourceStatus(address, { refresh = false } = {}) {
    const key = String(address ?? '')
    const cached = cache.get(key)
    if (!refresh && cached && cached.expiresAt > Date.now()) return { ...cached.result, cache: 'cached' }
    if (inFlight.has(key)) return inFlight.get(key)
    const promise = readFresh(key).then((result) => {
      cache.set(key, { result, expiresAt: Date.now() + (result.success ? 5000 : 1500) })
      if (cache.size > 100) cache.delete(cache.keys().next().value)
      return { ...result, cache: result.success ? 'fresh' : 'failed' }
    }).finally(() => inFlight.delete(key))
    inFlight.set(key, promise)
    return promise
  }
}
