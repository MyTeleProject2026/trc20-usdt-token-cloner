import { randomUUID } from 'node:crypto'

const URLS = Object.freeze({
  sandbox: 'https://api.sandbox.palisade.co',
  production: 'https://api.palisade.co',
})
const TRX_DECIMALS = 6
const POSITIVE_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(name + '-not-configured')
  return value.trim()
}

function parseTrxToSun(value) {
  const raw = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
  if (!POSITIVE_DECIMAL.test(raw)) throw new Error('invalid-trx-amount')
  const [whole, fraction = ''] = raw.split('.')
  const sun = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(TRX_DECIMALS, '0'))
  if (sun <= 0n) throw new Error('invalid-trx-amount')
  return sun
}

function parseDecimalToSun(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  return (BigInt(whole) * 1_000_000n + BigInt((fraction || '').padEnd(6, '0') || '0')).toString()
}

function readWalletConfig(env) {
  const environment = env.RIPPLE_CUSTODY_ENV === 'production' ? 'production' : 'sandbox'
  const clientId = env.RIPPLE_WALLETS_CLIENT_ID?.trim() || ''
  const clientSecret = env.RIPPLE_WALLETS_CLIENT_SECRET?.trim() || ''
  const transactionClientId = env.RIPPLE_TRANSACTIONS_CLIENT_ID?.trim() || ''
  const transactionClientSecret = env.RIPPLE_TRANSACTIONS_CLIENT_SECRET?.trim() || ''
  const vaultId = env.RIPPLE_VAULT_ID?.trim() || ''
  const walletId = env.RIPPLE_WALLET_ID?.trim() || ''
  const sourceAddress = env.RIPPLE_TRON_SOURCE_ADDRESS?.trim() || ''
  const destinationAddress = env.RESTRICTED_TRX_BENEFICIARY_ADDRESS?.trim() || ''
  return {
    environment,
    baseUrl: URLS[environment],
    walletsCredentialConfigured: Boolean(clientId && clientSecret),
    transactionsCredentialConfigured: Boolean(transactionClientId && transactionClientSecret),
    walletConfigured: Boolean(vaultId && walletId),
    sourceAddressConfigured: Boolean(sourceAddress),
    destinationAddressConfigured: Boolean(destinationAddress),
    configured: Boolean(clientId && clientSecret && transactionClientId && transactionClientSecret && vaultId && walletId && sourceAddress && destinationAddress),
    clientId,
    clientSecret,
    transactionClientId,
    transactionClientSecret,
    vaultId,
    walletId,
    sourceAddress,
    destinationAddress,
  }
}

export function getRippleCustodyConfigurationStatus(env = process.env) {
  const config = readWalletConfig(env)
  return Object.freeze({
    provider: 'ripple-custody-wallet',
    environment: config.environment,
    walletsCredentialConfigured: config.walletsCredentialConfigured,
    transactionsCredentialConfigured: config.transactionsCredentialConfigured,
    walletConfigured: config.walletConfigured,
    sourceAddressConfigured: config.sourceAddressConfigured,
    destinationAddressConfigured: config.destinationAddressConfigured,
    configured: config.configured,
    creditFacilityVerified: false,
    principalCreditAvailableSun: null,
    feeCreditAvailableSun: null,
    liveTransferEnabled: false,
    note: 'API configuration is not a credit facility. No TRX principal or fee-credit allocation is assumed.',
  })
}

export function createRippleCustodyClient({
  env = process.env,
  fetchImpl = globalThis.fetch,
  liveTransferAuthorization = () => false,
} = {}) {
  const config = readWalletConfig(env)
  if (typeof fetchImpl !== 'function') throw new Error('fetch-unavailable')

  async function jsonRequest(path, { method = 'GET', body, token, apiClientId, apiClientSecret } = {}) {
    let bearer = token
    if (!bearer) {
      const clientId = required(apiClientId, 'ripple-client-id')
      const clientSecret = required(apiClientSecret, 'ripple-client-secret')
      const response = await fetchImpl(config.baseUrl + '/v2/credentials/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ clientId, clientSecret }),
        signal: AbortSignal.timeout(15000),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.accessToken) {
        const error = new Error('ripple-authentication-failed')
        error.status = response.status
        throw error
      }
      bearer = payload.accessToken
    }
    const response = await fetchImpl(config.baseUrl + path, {
      method,
      headers: {
        authorization: 'Bearer ' + bearer,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20000),
    })
    if (response.status === 204) return null
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      const error = new Error('ripple-api-request-failed')
      error.status = response.status
      error.providerError = payload?.message || payload?.reason || payload?.code || null
      throw error
    }
    return payload
  }

  function walletPath(suffix = '') {
    return '/v2/vaults/' + encodeURIComponent(required(config.vaultId, 'ripple-vault-id'))
      + '/wallets/' + encodeURIComponent(required(config.walletId, 'ripple-wallet-id')) + suffix
  }

  async function getWalletBalances() {
    const data = await jsonRequest(walletPath('/balances?filter.blockchain.eq=TRON'), {
      apiClientId: config.clientId,
      apiClientSecret: config.clientSecret,
    })
    const balances = Array.isArray(data?.balances) ? data.balances : []
    const trx = balances.find((item) =>
      item?.asset?.blockchain === 'TRON'
      && item?.asset?.standard === 'NATIVE'
      && item?.asset?.symbol === 'TRX',
    )
    if (!trx) {
      return Object.freeze({
        found: false,
        symbol: 'TRX',
        blockchain: 'TRON',
        totalTrx: null,
        availableTrx: null,
        pendingTrx: null,
        frozenTrx: null,
        totalSun: null,
        availableSun: null,
        assetId: null,
        note: 'Ripple did not return a tracked native TRX balance for this wallet.',
      })
    }
    const totalSun = parseDecimalToSun(String(trx.balance ?? ''))
    const availableSun = parseDecimalToSun(String(trx.availableBalance ?? ''))
    const pendingSun = parseDecimalToSun(String(trx.pendingBalance ?? ''))
    const frozenSun = parseDecimalToSun(String(trx.frozenBalance ?? ''))
    if ([totalSun, availableSun, pendingSun, frozenSun].some((v) => v === null)) {
      throw new Error('ripple-trx-balance-response-invalid')
    }
    const toDecimal = (sun) => {
      const value = BigInt(sun)
      return (value / 1_000_000n).toString() + '.' + (value % 1_000_000n).toString().padStart(6, '0')
    }
    return Object.freeze({
      found: true,
      symbol: 'TRX',
      blockchain: 'TRON',
      totalTrx: toDecimal(totalSun),
      availableTrx: toDecimal(availableSun),
      pendingTrx: toDecimal(pendingSun),
      frozenTrx: toDecimal(frozenSun),
      totalSun,
      availableSun,
      pendingSun,
      frozenSun,
      assetId: trx.asset?.id || null,
      source: 'ripple-custody-wallet-api',
      creditFacilityVerified: false,
      note: 'This is the balance held in the configured Ripple custody wallet, not evidence of a loan or credit facility.',
    })
  }

  async function estimateNativeTrxTransferFee({ destinationAddress = config.destinationAddress } = {}) {
    const destination = required(destinationAddress, 'ripple-tron-destination')
    if (destination !== config.destinationAddress) throw new Error('destination-not-allowlisted')
    const data = await jsonRequest('/v2/transactions/transfer/estimate-fee', {
      method: 'POST',
      apiClientId: config.transactionClientId,
      apiClientSecret: config.transactionClientSecret,
      body: {
        blockchain: 'TRON',
        symbol: 'TRX',
        originAddress: required(config.sourceAddress, 'ripple-tron-source-address'),
        destinationAddress: destination,
      },
    })
    const average = data?.networkFees?.average
    const averageSun = parseDecimalToSun(String(average ?? ''))
    if (averageSun === null) throw new Error('ripple-trx-fee-estimate-invalid')
    return Object.freeze({
      blockchain: 'TRON',
      symbol: 'TRX',
      averageTrx: String(average),
      averageSun,
      networkFees: data.networkFees,
      source: 'ripple-custody-wallet-api',
    })
  }

  async function getTransaction(transactionId) {
    const id = required(transactionId, 'ripple-transaction-id')
    if (!/^[A-Za-z0-9-]{8,80}$/.test(id)) throw new Error('invalid-ripple-transaction-id')
    return jsonRequest(walletPath('/transactions/' + encodeURIComponent(id)), {
      apiClientId: config.transactionClientId,
      apiClientSecret: config.transactionClientSecret,
    })
  }

  async function createNativeTrxTransfer({
    amountTrx,
    destinationAddress = config.destinationAddress,
    networkFeeTrx,
    externalId = randomUUID(),
    fundingAuthorization,
  } = {}) {
    // This is a final safety latch, not a setting exposed to the browser.
    // The application deliberately supplies no authorization until a real,
    // provider-issued facility/allocation has been independently validated.
    if (liveTransferAuthorization() !== true) {
      const error = new Error('ripple-live-transfer-disabled-until-provider-funding-is-verified')
      error.status = 423
      throw error
    }
    if (!fundingAuthorization || fundingAuthorization.provider !== 'ripple'
      || fundingAuthorization.status !== 'approved'
      || fundingAuthorization.signatureVerified !== true
      || !fundingAuthorization.agreementReference
      || !fundingAuthorization.authorizationId
      || !Number.isFinite(Date.parse(fundingAuthorization.expiresAt))
      || Date.parse(fundingAuthorization.expiresAt) <= Date.now()) {
      const error = new Error('provider-credit-facility-not-verified')
      error.status = 423
      throw error
    }
    const destination = required(destinationAddress, 'ripple-tron-destination')
    if (destination !== config.destinationAddress) throw new Error('destination-not-allowlisted')
    const amountSun = parseTrxToSun(amountTrx)
    if (amountSun > BigInt(fundingAuthorization.availablePrincipalSun || '0')
      || amountSun > BigInt(fundingAuthorization.creditLimitSun || '0')) {
      const error = new Error('provider-credit-principal-insufficient')
      error.status = 409
      throw error
    }
    const feeSun = parseTrxToSun(networkFeeTrx)
    if (feeSun > BigInt(fundingAuthorization.feeBudgetSun || '0')) {
      const error = new Error('provider-credit-fee-budget-insufficient')
      error.status = 409
      throw error
    }
    const amount = typeof amountTrx === 'string' ? amountTrx : String(amountTrx)
    const fee = typeof networkFeeTrx === 'string' ? networkFeeTrx : String(networkFeeTrx)
    const data = await jsonRequest(walletPath('/transactions/transfer'), {
      method: 'POST',
      apiClientId: config.transactionClientId,
      apiClientSecret: config.transactionClientSecret,
      body: {
        destinationAddress: destination,
        symbol: 'TRX',
        qty: amount,
        networkFee: fee,
        externalId: required(externalId, 'ripple-external-id'),
      },
    })
    return Object.freeze({
      provider: 'ripple',
      submitted: true,
      providerTransactionId: data?.id || null,
      status: data?.status || 'REQUESTED',
      destinationAddress: destination,
      amountTrx: amount,
      networkFeeLimitTrx: fee,
      response: data,
    })
  }

  return Object.freeze({
    getWalletBalances,
    estimateNativeTrxTransferFee,
    getTransaction,
    createNativeTrxTransfer,
  })
}

export { parseDecimalToSun, parseTrxToSun }
