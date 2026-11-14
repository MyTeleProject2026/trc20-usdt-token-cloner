import { createHash } from 'node:crypto'
import { tatumProviderFetch } from './tatum-provider-fetch.mjs'

const MAINNET = Object.freeze({
  host: 'https://api.trongrid.io',
  publicNodeHost: 'https://tron-rpc.publicnode.com',
  tatumHost: 'https://tron-mainnet.gateway.tatum.io',
})
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const UINT = /^(0|[1-9][0-9]{0,77})$/
const MAX_DELEGATORS = 10

function isValidMainnetAddress(address) {
  if (typeof address !== 'string' || !ADDRESS_PATTERN.test(address)) return false
  let decoded = 0n
  for (const char of address) {
    const digit = BASE58.indexOf(char)
    if (digit < 0) return false
    decoded = decoded * 58n + BigInt(digit)
  }
  let hex = decoded.toString(16)
  if (hex.length % 2) hex = '0' + hex
  let payload = Buffer.from(hex, 'hex')
  let leadingZeroes = 0
  while (leadingZeroes < address.length && address[leadingZeroes] === '1') leadingZeroes++
  if (leadingZeroes) payload = Buffer.concat([Buffer.alloc(leadingZeroes), payload])
  if (payload.length !== 25 || payload[0] !== 0x41) return false
  const body = payload.subarray(0, 21)
  const checksum = payload.subarray(21)
  const expected = createHash('sha256').update(createHash('sha256').update(body).digest()).digest().subarray(0, 4)
  return checksum.equals(expected)
}
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

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
  addressValidator = isValidMainnetAddress,
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
      { name: 'PublicNode', host: MAINNET.publicNodeHost, headers: { 'content-type': 'application/json' } },
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

  async function readTenergyResources(address) {
    const response = await fetchImpl('https://api.tenergy.me/v1/resources/' + encodeURIComponent(address), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response?.ok) {
      const error = new Error('TEnergy public resource endpoint returned HTTP ' + (response?.status || 'unknown'))
      error.category = response?.status === 429 ? 'rate-limited' : 'provider-http-error'
      error.httpStatus = Number.isInteger(response?.status) ? response.status : undefined
      error.stage = 'tenergy-resources'
      throw error
    }
    let payload
    try { payload = await response.json() } catch {
      const error = new Error('TEnergy public resource endpoint returned invalid JSON')
      error.category = 'invalid-json'
      error.stage = 'tenergy-resources'
      throw error
    }
    const numericFields = [
      payload?.energy?.available, payload?.energy?.limit, payload?.energy?.used, payload?.energy?.delegated_in,
      payload?.bandwidth?.available, payload?.bandwidth?.limit, payload?.bandwidth?.used,
      payload?.bandwidth?.delegated_in, payload?.bandwidth?.free_net_limit,
    ]
    if (payload?.address !== address || typeof payload?.activated !== 'boolean'
      || numericFields.some(value => integer(value, null) === null)
      || typeof payload?.as_of !== 'string' || !Number.isFinite(Date.parse(payload.as_of))) {
      const error = new Error('TEnergy public resource response did not match its documented Mainnet schema')
      error.category = 'invalid-resource-response'
      error.stage = 'tenergy-resources'
      throw error
    }
    if (BigInt(payload.energy.used) > BigInt(payload.energy.limit)
      || BigInt(payload.bandwidth.used) > BigInt(payload.bandwidth.limit)
      || BigInt(payload.energy.available) !== BigInt(payload.energy.limit) - BigInt(payload.energy.used)) {
      const error = new Error('TEnergy public resource counters are internally inconsistent')
      error.category = 'invalid-resource-response'
      error.stage = 'tenergy-resources'
      throw error
    }
    return payload
  }

  async function readChainParameters() {
    const result = await post('/wallet/getchainparameters', {}, 'chain-parameters')
    const list = Array.isArray(result.payload.chainParameter) ? result.payload.chainParameter : []
    const get = key => {
      const item = list.find(entry => entry?.key === key)
      return integer(item?.value, null)
    }
    const energyFeeSun = get('getEnergyFee')
    const bandwidthFeeSun = get('getTransactionFee')
    const maxFeeLimitSun = get('getMaxFeeLimit')
    if (energyFeeSun === null || BigInt(energyFeeSun) <= 0n
      || bandwidthFeeSun === null || BigInt(bandwidthFeeSun) <= 0n
      || maxFeeLimitSun === null || BigInt(maxFeeLimitSun) <= 0n) {
      throw Object.assign(new Error('invalid-deployment-resource-parameters'), { category: 'invalid-deployment-resource-parameters', stage: 'chain-parameters' })
    }
    return { energyFeeSun, bandwidthFeeSun, maxFeeLimitSun, provider: result.provider }
  }

  function makeTenergySnapshot(address, chain, payload) {
    const balanceSun = integer(payload.balance_sun, null)
    if (balanceSun === null) {
      throw Object.assign(new Error('TEnergy resource response omitted native balance'), { category: 'invalid-resource-response', stage: 'tenergy-resources' })
    }
    const energyAvailable = integer(payload.energy.available)
    const energyLimit = integer(payload.energy.limit)
    const energyUsed = integer(payload.energy.used)
    const energyDelegatedIn = integer(payload.energy.delegated_in)
    const bandwidthAvailable = integer(payload.bandwidth.available)
    const bandwidthLimit = integer(payload.bandwidth.limit)
    const bandwidthUsed = integer(payload.bandwidth.used)
    const bandwidthDelegatedIn = integer(payload.bandwidth.delegated_in)
    const freeBandwidthLimit = integer(payload.bandwidth.free_net_limit)
    return {
      success: true,
      network: 'mainnet',
      status: 'mainnet-resource-snapshot-read',
      address,
      checkedAt: payload.as_of,
      source: 'TEnergy public Mainnet resource API + ' + chain.provider,
      resourceRead: true,
      resourceProvider: 'TEnergy',
      resources: {
        energyAvailable, energyLimit, energyUsed, energyDelegatedIn,
        bandwidthAvailableForOneTransaction: bandwidthAvailable,
        bandwidthLimit, bandwidthUsed, bandwidthDelegatedIn,
        freeBandwidthLimit,
        nativeBalanceSun: balanceSun,
      },
      deploymentResourceSnapshot: {
        energyAvailable,
        freeBandwidthAvailable: '0',
        stakedBandwidthAvailable: '0',
        bandwidthAvailableForOneTransaction: bandwidthAvailable,
        nativeBalanceSun: balanceSun,
        energyFeeSun: chain.energyFeeSun,
        bandwidthFeeSun: chain.bandwidthFeeSun,
        maxFeeLimitSun: chain.maxFeeLimitSun,
      },
      inboundDelegations: {
        count: null,
        energyDelegatedIn,
        bandwidthDelegatedIn,
        records: [],
        source: 'TEnergy public Mainnet resource API',
        identitiesAvailable: false,
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
        freeEnergyProvider: 'TEnergy public Mainnet resource API',
        freeEnergyProviderStatus: energyDelegatedIn !== '0' ? 'incoming-energy-delegation-observed' : 'no-incoming-energy-delegation',
        freeBandwidthProviderStatus: bandwidthDelegatedIn !== '0' ? 'incoming-bandwidth-delegation-observed' : 'no-incoming-bandwidth-delegation',
        note: 'TEnergy public API reads current Mainnet resource counters and inbound delegation amounts without credentials. It does not grant resources or imply promotional eligibility.',
      },
      transactionActions: { unsignedTransactionCreated: false, walletSignatureRequested: false, transactionBroadcast: false },
    }
  }

  async function readNodeFallback(address, primaryFailure) {
    const resourceResult = await post('/wallet/getaccountresource', { address, visible: true }, 'account-resource')
    const accountResult = await post('/wallet/getaccount', { address, visible: true }, 'account-balance')
    const chainParametersResult = await readChainParameters()
    const indexResult = await post('/wallet/getdelegatedresourceaccountindexv2', { value: address, visible: true }, 'delegation-index')
    const resources = resourceResult.payload
    const account = accountResult.payload
    const index = indexResult.payload
    const fields = {
      energyLimit: integer(resources.EnergyLimit, '0'),
      energyUsed: integer(resources.EnergyUsed, '0'),
      bandwidthLimit: integer(resources.NetLimit, '0'),
      bandwidthUsed: integer(resources.NetUsed, '0'),
      freeBandwidthLimit: integer(resources.freeNetLimit, '0'),
      freeBandwidthUsed: integer(resources.freeNetUsed, '0'),
    }
    if (Object.values(fields).some(value => value === null)
      || BigInt(fields.energyUsed) > BigInt(fields.energyLimit)
      || BigInt(fields.bandwidthUsed) > BigInt(fields.bandwidthLimit)
      || BigInt(fields.freeBandwidthUsed) > BigInt(fields.freeBandwidthLimit)) {
      throw Object.assign(new Error('invalid-resource-response'), { category: 'invalid-resource-response', stage: 'account-resource' })
    }
    const fromAccounts = Array.isArray(index.fromAccounts) ? index.fromAccounts : index.fromAccounts == null ? [] : null
    const toAccounts = Array.isArray(index.toAccounts) ? index.toAccounts : index.toAccounts == null ? [] : null
    if (!fromAccounts || !toAccounts) throw Object.assign(new Error('invalid-delegation-index'), { category: 'invalid-delegation-index', stage: 'delegation-index' })
    const nativeBalanceSun = integer(account.balance, '0')
    if (nativeBalanceSun === null) throw Object.assign(new Error('invalid-account-balance'), { category: 'invalid-resource-response', stage: 'account-balance' })
    const delegators = [...new Set(fromAccounts.filter(value => typeof value === 'string' && ADDRESS_PATTERN.test(value)))].slice(0, MAX_DELEGATORS)
    const records = []
    for (const delegator of delegators) {
      const detail = await post('/wallet/getdelegatedresourcev2', { fromAddress: delegator, toAddress: address, visible: true }, 'delegation-detail')
      const entries = Array.isArray(detail.payload.delegatedResource) ? detail.payload.delegatedResource
        : Array.isArray(detail.payload.delegated_resource) ? detail.payload.delegated_resource : []
      for (const entry of entries) {
        const energyStakeSun = integer(entry.frozen_balance_for_energy)
        const bandwidthStakeSun = integer(entry.frozen_balance_for_bandwidth)
        if (energyStakeSun === null || bandwidthStakeSun === null) throw Object.assign(new Error('invalid-delegation-detail'), { category: 'invalid-delegation-detail', stage: 'delegation-detail' })
        if (BigInt(energyStakeSun) > 0n || BigInt(bandwidthStakeSun) > 0n) records.push({
          delegator, energyStakeSun, bandwidthStakeSun,
          energyExpireTime: integer(entry.expire_time_for_energy, '0'),
          bandwidthExpireTime: integer(entry.expire_time_for_bandwidth, '0'),
        })
      }
    }
    const energyAvailable = (BigInt(fields.energyLimit) - BigInt(fields.energyUsed)).toString()
    const freeBandwidthAvailable = (BigInt(fields.freeBandwidthLimit) - BigInt(fields.freeBandwidthUsed)).toString()
    const stakedBandwidthAvailable = (BigInt(fields.bandwidthLimit) - BigInt(fields.bandwidthUsed)).toString()
    return {
      success: true, network: 'mainnet', status: 'mainnet-resource-snapshot-read', address,
      checkedAt: new Date().toISOString(), source: 'TRON Mainnet FullNode fallback', resourceRead: true,
      resourceProvider: 'TRON Mainnet FullNode',
      resources: {
        energyAvailable, energyLimit: fields.energyLimit, energyUsed: fields.energyUsed,
        energyDelegatedIn: null, bandwidthAvailableForOneTransaction: Math.max(Number(freeBandwidthAvailable), Number(stakedBandwidthAvailable)).toString(),
        freeBandwidthAvailable, freeBandwidthLimit: fields.freeBandwidthLimit, freeBandwidthUsed: fields.freeBandwidthUsed,
        stakedOrDelegatedBandwidthAvailable: stakedBandwidthAvailable, stakedOrDelegatedBandwidthLimit: fields.bandwidthLimit,
        stakedOrDelegatedBandwidthUsed: fields.bandwidthUsed, bandwidthDelegatedIn: null, nativeBalanceSun,
      },
      deploymentResourceSnapshot: {
        energyAvailable, freeBandwidthAvailable, stakedBandwidthAvailable,
        bandwidthAvailableForOneTransaction: null,
        nativeBalanceSun, energyFeeSun: chainParametersResult.energyFeeSun,
        bandwidthFeeSun: chainParametersResult.bandwidthFeeSun, maxFeeLimitSun: chainParametersResult.maxFeeLimitSun,
      },
      inboundDelegations: {
        count: records.length, energyDelegatedIn: null, bandwidthDelegatedIn: null, records,
        truncated: fromAccounts.length > MAX_DELEGATORS, identitiesAvailable: true,
      },
      policy: {
        mode: 'free-delegation', walletApprovalRequired: true, walletAddress: address, network: 'mainnet',
        sponsorAccountConfigured: false, paidRentalEnabled: false, paidFallbackEnabled: false,
        automaticDelegationEnabled: false, protocolFreeEnergyQuota: '0', freeBandwidthIsProtocolQuota: true,
        freeEnergyProvider: 'not-configured', freeEnergyProviderStatus: 'no-verified-free-delegation-api',
        note: 'TRON Mainnet FullNode fallback. No free Energy or delegation has been assumed.',
        primaryProviderFailure: primaryFailure?.category || 'tenergy-unavailable',
      },
      transactionActions: { unsignedTransactionCreated: false, walletSignatureRequested: false, transactionBroadcast: false },
    }
  }

  async function readFresh(address) {
    if (typeof address !== 'string' || !ADDRESS_PATTERN.test(address) || !addressValidator(address)) {
      return { success: false, network: 'mainnet', status: 'invalid-mainnet-address', resourceRead: false }
    }
    let primaryFailure = null
    try {
      const payload = await readTenergyResources(address)
      const chain = await readChainParameters()
      return makeTenergySnapshot(address, chain, payload)
    } catch (error) {
      primaryFailure = error
    }
    try {
      return await readNodeFallback(address, primaryFailure)
    } catch (error) {
      return {
        success: false, network: 'mainnet', status: 'resource-read-unavailable', resourceRead: false,
        ...(Number.isInteger(error?.httpStatus) ? { providerStatus: error.httpStatus } : {}),
        failureStage: typeof error?.stage === 'string' ? error.stage : 'provider-read',
        providerResponseCategory: typeof error?.category === 'string' ? error.category : 'provider-unavailable',
        primaryProvider: 'TEnergy public Mainnet resource API',
        primaryProviderFailure: primaryFailure?.category || 'provider-unavailable',
        policy: {
          mode: 'free-delegation', walletApprovalRequired: true, network: 'mainnet',
          sponsorAccountConfigured: false, paidRentalEnabled: false, paidFallbackEnabled: false,
          automaticDelegationEnabled: false, protocolFreeEnergyQuota: '0',
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
