import { createHmac, timingSafeEqual } from 'node:crypto'

const API_BASES = new Set(['https://sandboxapi.fincra.com', 'https://api.fincra.com'])
const CUSTOMER_REFERENCE_PATTERN = /^[A-Za-z0-9._:-]{12,128}$/
const TRON_ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const CURRENCY_PATTERN = /^[A-Z]{3,10}$/
const MAX_AMOUNT = 1_000_000_000

export class FincraConfigurationError extends Error {
  constructor(code) {
    super(code)
    this.name = 'FincraConfigurationError'
    this.code = code
  }
}

export class FincraApiError extends Error {
  constructor(status, code = 'fincra-provider-error') {
    super(code)
    this.name = 'FincraApiError'
    this.status = status
    this.code = code
  }
}

export function fincraConfiguration(env = process.env) {
  const apiBaseInput = typeof env.FINCRA_API_BASE === 'string' && env.FINCRA_API_BASE.trim()
    ? env.FINCRA_API_BASE.trim().replace(/\/+$/, '')
    : 'https://sandboxapi.fincra.com'
  const apiKey = typeof env.FINCRA_API_KEY === 'string' ? env.FINCRA_API_KEY.trim() : ''
  const businessId = typeof env.FINCRA_BUSINESS_ID === 'string' ? env.FINCRA_BUSINESS_ID.trim() : ''
  const webhookSecret = typeof env.FINCRA_WEBHOOK_SECRET === 'string' ? env.FINCRA_WEBHOOK_SECRET.trim() : ''
  const sourceCurrency = typeof env.FINCRA_SOURCE_CURRENCY === 'string' ? env.FINCRA_SOURCE_CURRENCY.trim().toUpperCase() : 'USDT'
  const enabledFlag = env.FINCRA_PAYOUTS_ENABLED === 'true'
  const missing = []
  if (!API_BASES.has(apiBaseInput)) missing.push('FINCRA_API_BASE')
  if (!apiKey) missing.push('FINCRA_API_KEY')
  if (!businessId || businessId.length > 128 || /[\r\n]/.test(businessId)) missing.push('FINCRA_BUSINESS_ID')
  if (!webhookSecret) missing.push('FINCRA_WEBHOOK_SECRET')
  if (!CURRENCY_PATTERN.test(sourceCurrency)) missing.push('FINCRA_SOURCE_CURRENCY')
  return {
    configured: missing.length === 0,
    enabledFlag,
    missing,
    apiBase: apiBaseInput,
    apiKey,
    businessId,
    webhookSecret,
    sourceCurrency,
    environment: apiBaseInput === 'https://api.fincra.com' ? 'live' : 'sandbox',
  }
}

export function isValidFincraAmount(value, { max = MAX_AMOUNT } = {}) {
  if (typeof value !== 'string' || value.length > 24
    || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(value)) return false
  const number = Number(value)
  return Number.isFinite(number) && number > 0 && number <= max
}

function toProviderNumber(value) {
  if (!isValidFincraAmount(value)) throw new TypeError('Invalid payout amount.')
  const parsed = Number(value)
  const normalized = value.includes('.') ? value.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') : value
  if (!Number.isFinite(parsed) || parsed.toFixed(6).replace(/0+$/, '').replace(/\.$/, '') !== normalized) {
    throw new TypeError('Payout amount cannot be represented safely by the provider numeric field.')
  }
  return parsed
}

function safePathSegment(value) {
  if (typeof value !== 'string' || !CUSTOMER_REFERENCE_PATTERN.test(value)) throw new TypeError('Invalid Fincra reference.')
  return encodeURIComponent(value)
}

export function verifyFincraWebhookSignature(payload, signature, secret) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || typeof signature !== 'string' || !/^[a-f0-9]{128}$/i.test(signature)
    || typeof secret !== 'string' || secret.length === 0) return false
  const expected = createHmac('sha512', secret).update(JSON.stringify(payload)).digest()
  const supplied = Buffer.from(signature, 'hex')
  return supplied.length === expected.length && timingSafeEqual(expected, supplied)
}

export function createFincraClient({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 20_000 } = {}) {
  const config = fincraConfiguration(env)
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function')

  async function request(path, { method = 'GET', body } = {}) {
    if (!config.configured) throw new FincraConfigurationError('fincra-not-configured')
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('#')) throw new TypeError('Invalid Fincra API path.')
    let response
    try {
      response = await fetchImpl(config.apiBase + path, {
        method,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': config.apiKey },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch {
      const error = new Error('Fincra provider request outcome is unknown.')
      error.code = 'fincra-network-outcome-unknown'
      throw error
    }
    let payload = null
    try { payload = await response.json() } catch {}
    if (!response.ok || payload?.success === false) {
      const error = new FincraApiError(response.status, 'fincra-provider-request-failed')
      error.providerMessage = typeof payload?.message === 'string' ? payload.message.slice(0, 200) : undefined
      throw error
    }
    return payload
  }

  return Object.freeze({
    isConfigured: () => config.configured,
    isEnabled: () => config.configured && config.enabledFlag,
    configuration: () => ({
      configured: config.configured,
      enabledFlag: config.enabledFlag,
      environment: config.environment,
      sourceCurrency: config.sourceCurrency,
      missing: [...config.missing],
    }),
    async generateUsdtTrc20Quote({ amount, customerReference, sourceCurrency = config.sourceCurrency, feeBearer = 'business' } = {}) {
      if (!isValidFincraAmount(amount)) throw new TypeError('Invalid quote amount.')
      safePathSegment(customerReference)
      const currency = String(sourceCurrency || '').toUpperCase()
      if (!CURRENCY_PATTERN.test(currency)) throw new TypeError('Invalid source currency.')
      return request('/quotes/generate', {
        method: 'POST',
        body: {
          business: config.businessId,
          sourceCurrency: currency,
          destinationCurrency: 'USDT',
          amount: toProviderNumber(amount),
          action: 'send',
          transactionType: 'disbursement',
          feeBearer,
          paymentDestination: 'crypto_wallet',
          paymentScheme: 'usdt_trc20',
          customerReference,
        },
      })
    },
    async createUsdtTrc20Payout({
      amount, customerReference, walletAddress, accountHolderName, quoteReference,
      sourceCurrency = config.sourceCurrency, email, description = 'TRON Token Studio USDT TRC20 payout',
    } = {}) {
      if (!isValidFincraAmount(amount)) throw new TypeError('Invalid payout amount.')
      safePathSegment(customerReference)
      if (!TRON_ADDRESS_PATTERN.test(walletAddress || '')) throw new TypeError('Invalid TRON recipient address.')
      if (typeof accountHolderName !== 'string' || !accountHolderName.trim() || accountHolderName.trim().length > 120) {
        throw new TypeError('A beneficiary account holder name is required.')
      }
      const currency = String(sourceCurrency || '').toUpperCase()
      if (!CURRENCY_PATTERN.test(currency)) throw new TypeError('Invalid source currency.')
      if (currency !== 'USDT' && (typeof quoteReference !== 'string' || !quoteReference.trim())) {
        throw new TypeError('A Fincra quote reference is required when source currency differs from USDT.')
      }
      return request('/disbursements/payouts', {
        method: 'POST',
        body: {
          business: config.businessId,
          sourceCurrency: currency,
          destinationCurrency: 'USDT',
          amount: toProviderNumber(amount),
          customerReference,
          description: String(description).slice(0, 180),
          paymentDestination: 'crypto_wallet',
          paymentScheme: 'usdt_trc20',
          ...(currency === 'USDT' ? {} : { quoteReference }),
          beneficiary: {
            walletAddress,
            accountHolderName: accountHolderName.trim(),
            ...(typeof email === 'string' && email.trim() ? { email: email.trim().slice(0, 254) } : {}),
          },
        },
      })
    },
    async getPayoutByCustomerReference(customerReference) {
      return request('/disbursements/payouts/customer-reference/' + safePathSegment(customerReference))
    },
    async getPayoutByTransactionReference(transactionReference) {
      return request('/disbursements/payouts/reference/' + safePathSegment(transactionReference))
    },
    verifyWebhook(payload, signature) {
      return verifyFincraWebhookSignature(payload, signature, config.webhookSecret)
    },
  })
}
