import { createHmac, timingSafeEqual } from 'node:crypto'
import { isValidTronAddress } from './tron-address.mjs'

export const FINCRA_MAINNET_USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
export const FINCRA_USDT_TRON_SCHEME = 'usdt_trc20'

const BASE_UNITS = 1_000_000n
const MAX_AMOUNT_BASE_UNITS = 1_000_000_000_000_000n
const BUSINESS_ID_RE = /^[A-Za-z0-9._:-]{4,128}$/
const CUSTOMER_REFERENCE_RE = /^[A-Za-z0-9._:-]{8,80}$/

function clean(value, max = 256) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

export function parseFincraUsdtBaseUnits(value) {
  const raw = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(raw)) return null
  const [whole, fraction = ''] = raw.split('.')
  try {
    return (BigInt(whole) * BASE_UNITS + BigInt(fraction.padEnd(6, '0') || '0')).toString()
  } catch {
    return null
  }
}

function toFincraNumericAmount(value) {
  const baseUnits = parseFincraUsdtBaseUnits(value)
  if (baseUnits === null || BigInt(baseUnits) <= 0n || BigInt(baseUnits) > MAX_AMOUNT_BASE_UNITS) {
    throw new Error('amount-must-be-positive-usdt-with-at-most-six-decimals-and-within-limit')
  }
  const integer = BigInt(baseUnits) / BASE_UNITS
  const fraction = (BigInt(baseUnits) % BASE_UNITS).toString().padStart(6, '0').replace(/0+$/, '')
  const decimal = integer.toString() + (fraction ? '.' + fraction : '')
  const numeric = Number(decimal)
  if (!Number.isFinite(numeric) || Number(numeric.toFixed(6)) !== numeric) {
    throw new Error('amount-cannot-be-represented-exactly-for-provider-api')
  }
  return { baseUnits, decimal, numeric }
}

export function getFincraConfig(env = process.env) {
  const mode = env.FINCRA_ENVIRONMENT === 'live' ? 'live' : 'sandbox'
  return {
    mode,
    baseUrl: mode === 'live' ? 'https://api.fincra.com' : 'https://sandboxapi.fincra.com',
    apiKey: clean(env.FINCRA_SECRET_KEY, 4096),
    businessId: clean(env.FINCRA_BUSINESS_ID, 128),
    sourceCurrency: clean(env.FINCRA_SOURCE_CURRENCY || 'USDT', 8).toUpperCase(),
  }
}

export function buildFincraUsdtTronPayoutPayload(input = {}) {
  const businessId = clean(input.businessId, 128)
  const recipientAddress = clean(input.recipientAddress, 64)
  const beneficiaryName = clean(input.beneficiaryName, 120)
  const customerReference = clean(input.customerReference, 80)
  const amount = toFincraNumericAmount(input.amount)
  const beneficiaryEmail = clean(input.beneficiaryEmail, 254).toLowerCase()
  const destinationTag = clean(input.destinationTag, 128)

  if (destinationTag && !/^[A-Za-z0-9._:-]{1,128}$/.test(destinationTag)) {
    throw new Error('invalid-beneficiary-destination-tag')
  }

  if (!BUSINESS_ID_RE.test(businessId)) throw new Error('invalid-fincra-business-id')
  if (!isValidTronAddress(recipientAddress)) throw new Error('invalid-tron-mainnet-recipient-address')
  if (beneficiaryName.length < 2) throw new Error('beneficiary-name-required')
  if (!CUSTOMER_REFERENCE_RE.test(customerReference)) throw new Error('invalid-unique-customer-reference')
  if (beneficiaryEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(beneficiaryEmail)) {
    throw new Error('invalid-beneficiary-email')
  }

  return {
    business: businessId,
    sourceCurrency: 'USDT',
    destinationCurrency: 'USDT',
    amount: amount.numeric,
    customerReference,
    description: clean(input.description || 'Authorized TRON Mainnet USDT payout', 180),
    paymentDestination: 'crypto_wallet',
    paymentScheme: FINCRA_USDT_TRON_SCHEME,
    beneficiary: {
      walletAddress: recipientAddress,
      accountHolderName: beneficiaryName,
      ...(beneficiaryEmail ? { email: beneficiaryEmail } : {}),
      ...(destinationTag ? { destinationTag } : {}),
    },
  }
}

function unwrapData(payload) {
  return payload && typeof payload === 'object' && payload.data && typeof payload.data === 'object'
    ? payload.data : payload
}

function responseRows(payload) {
  const data = payload?.data
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.wallets)) return data.wallets
  if (Array.isArray(data?.results)) return data.results
  if (Array.isArray(data?.accounts)) return data.accounts
  if (Array.isArray(data?.balances)) return data.balances
  if (data && typeof data === 'object'
    && (data.currency || data.sourceCurrency)
    && (data.availableBalance !== undefined || data.available_balance !== undefined)) return [data]
  if (payload && typeof payload === 'object'
    && (payload.currency || payload.sourceCurrency)
    && (payload.availableBalance !== undefined || payload.available_balance !== undefined)) return [payload]
  return []
}

async function fincraRequest(config, path, { method = 'GET', body, fetchImpl = globalThis.fetch } = {}) {
  if (!config.apiKey) throw new Error('fincra-api-key-not-configured')
  if (typeof fetchImpl !== 'function') throw new Error('fetch-unavailable')
  const response = await fetchImpl(config.baseUrl + path, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'api-key': config.apiKey,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error',
    signal: AbortSignal.timeout(12000),
  })
  const payload = await response.json().catch(() => null)
  return { ok: response.ok, status: response.status, payload }
}

/**
 * Read-only account diagnostics. This reads the authenticated Fincra business
 * profile and its own USDT wallet; it does not submit a payout or prove legal
 * authority over the business account, source of funds, or a credit facility.
 */
export async function readFincraAccountDiagnostics(env = process.env, { fetchImpl = globalThis.fetch } = {}) {
  const config = getFincraConfig(env)
  const configured = Boolean(config.apiKey && BUSINESS_ID_RE.test(config.businessId))
  const result = {
    provider: 'fincra',
    configured,
    mode: config.mode,
    apiAuthenticated: false,
    businessIdMatches: false,
    usdtWalletFound: false,
    availableUsdtBalance: null,
    availableUsdtBalanceBaseUnits: null,
    accountBalanceIsSponsorBusinessFunds: true,
    payoutSubmissionEnabled: false,
    webhookSecretConfigured: Boolean(clean(env.FINCRA_WEBHOOK_SECRET || env.FINCRA_WEBHOOK_ENCRYPTION_KEY, 4096)),
    reasons: [],
    checkedAt: new Date().toISOString(),
  }

  if (!result.webhookSecretConfigured) result.reasons.push('fincra-webhook-secret-not-configured')
  if (!config.apiKey) {
    result.reasons.push('fincra-api-key-not-configured')
    return result
  }
  if (!BUSINESS_ID_RE.test(config.businessId)) {
    result.reasons.push('fincra-business-id-not-configured-or-invalid')
    return result
  }
  if (config.sourceCurrency !== 'USDT') {
    result.reasons.push('only-same-currency-usdt-source-is-supported-by-this-adapter')
    return result
  }

  try {
    const [profileResponse, walletsResponse] = await Promise.all([
      fincraRequest(config, '/profile/business/me', { fetchImpl }),
      fincraRequest(config, '/wallets?businessID=' + encodeURIComponent(config.businessId), { fetchImpl }),
    ])
    const profile = unwrapData(profileResponse.payload)
    const profileBusinessId = clean(profile?._id || profile?.id || profile?.businessId, 128)
    result.apiAuthenticated = profileResponse.ok && profileResponse.payload?.success !== false
    result.businessIdMatches = result.apiAuthenticated && profileBusinessId === config.businessId

    if (!result.apiAuthenticated) result.reasons.push('fincra-business-profile-authentication-failed')
    else if (!result.businessIdMatches) result.reasons.push('fincra-business-id-does-not-match-api-profile')

    if (!walletsResponse.ok || walletsResponse.payload?.success === false) {
      result.reasons.push('fincra-wallet-balance-read-failed')
      return result
    }

    const wallet = responseRows(walletsResponse.payload).find((item) =>
      clean(item?.currency || item?.sourceCurrency, 8).toUpperCase() === 'USDT')
    if (!wallet) {
      result.reasons.push('fincra-usdt-source-wallet-not-found')
      return result
    }

    const availableRaw = wallet.availableBalance ?? wallet.available_balance ?? wallet.balance?.availableBalance
    const availableBaseUnits = parseFincraUsdtBaseUnits(availableRaw)
    if (availableBaseUnits === null) {
      result.reasons.push('fincra-usdt-available-balance-unreadable')
      return result
    }

    result.usdtWalletFound = true
    result.availableUsdtBalance = String(availableRaw)
    result.availableUsdtBalanceBaseUnits = availableBaseUnits
    if (BigInt(availableBaseUnits) <= 0n) result.reasons.push('fincra-usdt-source-wallet-has-no-available-balance')
    if (!result.businessIdMatches) result.reasons.push('fincra-balance-not-accepted-without-business-id-match')
    return result
  } catch {
    result.reasons.push('fincra-diagnostics-unreachable')
    return result
  }
}

export function normalizeFincraPayoutRecord(payout, expected = {}) {
  if (!payout || typeof payout !== 'object' || Array.isArray(payout)) {
    return { valid: false, status: 'unknown', reason: 'fincra-payout-record-missing' }
  }

  const providerStatus = clean(payout.status, 32).toLowerCase()
  const status = providerStatus === 'successful' || providerStatus === 'failed' || providerStatus === 'processing'
    ? providerStatus : 'unknown'
  const customerReference = clean(payout.customerReference || payout.customer_reference, 80)
  const sourceCurrency = clean(payout.sourceCurrency, 8).toUpperCase()
  const destinationCurrency = clean(payout.destinationCurrency, 8).toUpperCase()
  const paymentScheme = clean(payout.paymentScheme, 32).toLowerCase()
  const paymentDestination = clean(payout.paymentDestination, 32).toLowerCase()
  const recipientAddress = clean(
    payout.beneficiary?.walletAddress || payout.beneficiary?.address
      || payout.recipient?.walletAddress || payout.recipient?.address
      || payout.walletAddress,
    64,
  )
  const destinationTag = clean(payout.beneficiary?.destinationTag || payout.destinationTag, 128)
  const expectedDestinationTag = clean(expected.destinationTag, 128)
  const expectedAmountBaseUnits = parseFincraUsdtBaseUnits(expected.amount)
  const amountReceivedBaseUnits = payout.amountReceived == null ? null : parseFincraUsdtBaseUnits(payout.amountReceived)
  const amountChargedBaseUnits = payout.amountCharged == null ? null : parseFincraUsdtBaseUnits(payout.amountCharged)
  const reasons = []

  if (status === 'unknown') reasons.push('unsupported-fincra-payout-status')
  const checks = [
    ['customer-reference-mismatch', customerReference, expected.customerReference],
    ['source-currency-mismatch', sourceCurrency, 'USDT'],
    ['destination-currency-mismatch', destinationCurrency, 'USDT'],
    ['payment-scheme-mismatch', paymentScheme, FINCRA_USDT_TRON_SCHEME],
    ['payment-destination-mismatch', paymentDestination, 'crypto_wallet'],
    ['recipient-mismatch', recipientAddress, expected.recipientAddress],
    ['destination-tag-mismatch', destinationTag, expectedDestinationTag],
  ]
  for (const [reason, actual, required] of checks) {
    if (!required || !actual || actual !== required) reasons.push(reason)
  }

  if (payout.amountReceived != null && amountReceivedBaseUnits === null) reasons.push('fincra-amount-received-invalid')
  if (payout.amountCharged != null && amountChargedBaseUnits === null) reasons.push('fincra-amount-charged-invalid')
  if (status === 'successful') {
    if (expectedAmountBaseUnits === null || amountReceivedBaseUnits === null) reasons.push('successful-payout-amount-evidence-missing')
    else if (amountReceivedBaseUnits !== expectedAmountBaseUnits) reasons.push('beneficiary-amount-does-not-equal-requested-amount')
  }

  const valid = reasons.length === 0 && status !== 'unknown'
  return {
    valid,
    status: valid ? status : 'manual-review',
    providerStatus: status,
    customerReference: customerReference || null,
    recipientAddress: recipientAddress || null,
    destinationTag: destinationTag || null,
    amountReceivedBaseUnits,
    amountChargedBaseUnits,
    reasons,
    transactionHash: clean(payout.transactionHash || payout.transaction_hash || payout.txId || payout.txHash, 128) || null,
    providerReference: clean(payout.reference || payout.transactionReference, 128) || null,
  }
}

export function verifyFincraWebhookSignature(payload, signature, secret) {
  const key = clean(secret, 4096)
  const supplied = clean(signature, 256).replace(/^sha512=/i, '').toLowerCase()
  if (!key || !/^[0-9a-f]{128}$/.test(supplied)) return false

  let parsed
  try {
    if (Buffer.isBuffer(payload)) parsed = JSON.parse(payload.toString('utf8'))
    else if (typeof payload === 'string') parsed = JSON.parse(payload)
    else parsed = payload
  } catch {
    return false
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false

  const expected = createHmac('sha512', key).update(JSON.stringify(parsed)).digest()
  const actual = Buffer.from(supplied, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/**
 * Sandbox-only submit helper. There is intentionally no live-submit option in
 * this initial adapter; live routing requires independently reviewed account
 * and mandate evidence plus production reconciliation and security approval.
 */
export async function initiateFincraSandboxUsdtTronPayout(env = process.env, input = {}, { fetchImpl = globalThis.fetch } = {}) {
  const config = getFincraConfig(env)
  if (config.mode !== 'sandbox') throw new Error('live-fincra-submission-not-enabled-in-this-release')
  if (env.FINCRA_SANDBOX_PAYOUTS_ENABLED !== 'true') throw new Error('fincra-sandbox-submission-disabled')
  if (!config.apiKey || !BUSINESS_ID_RE.test(config.businessId)) throw new Error('fincra-sandbox-credentials-not-configured')
  const payload = buildFincraUsdtTronPayoutPayload({ ...input, businessId: config.businessId })
  const response = await fincraRequest(config, '/disbursements/payouts', {
    method: 'POST',
    body: payload,
    fetchImpl,
  })
  if (!response.ok || response.payload?.success !== true) {
    const error = new Error('fincra-sandbox-payout-request-rejected')
    error.status = response.status
    throw error
  }
  const data = unwrapData(response.payload)
  const status = clean(data?.status, 32).toLowerCase()
  return {
    accepted: true,
    status: status === 'processing' || status === 'successful' || status === 'failed' ? status : 'unknown',
    customerReference: clean(data?.customerReference, 80) || payload.customerReference,
    providerReference: clean(data?.reference, 128) || null,
    payoutId: data?.id ?? null,
    sandboxOnly: true,
    settlementConfirmed: false,
  }
}

/**
 * Read-only reference lookup for an already-created Fincra payout.
 *
 * Unlike payout initiation, this operation is allowed in both sandbox and
 * live modes. A 404 is reported distinctly so callers can reconcile the
 * reference without confusing "not found" with provider/network failure.
 * A 404 after an ambiguous submission is not, by itself, permission to replay
 * the payout; callers must preserve the original request reference and avoid
 * blind resubmission.
 */
export async function lookupFincraPayoutByCustomerReference(
  env = process.env,
  customerReference,
  { fetchImpl = globalThis.fetch } = {},
) {
  const config = getFincraConfig(env)
  if (!config.apiKey || !BUSINESS_ID_RE.test(config.businessId)) {
    throw new Error('fincra-payout-lookup-credentials-not-configured')
  }
  const reference = clean(customerReference, 80)
  if (!CUSTOMER_REFERENCE_RE.test(reference)) throw new Error('invalid-customer-reference')
  const response = await fincraRequest(
    config,
    '/disbursements/payouts/customer-reference/' + encodeURIComponent(reference),
    { fetchImpl },
  )
  if (response.status === 404) return { found: false, status: 'not-found', payout: null }
  if (!response.ok || response.payload?.success === false) {
    const error = new Error('fincra-payout-lookup-failed')
    error.status = response.status
    throw error
  }
  const payout = unwrapData(response.payload)
  if (!payout || typeof payout !== 'object' || Array.isArray(payout)) {
    throw new Error('fincra-payout-lookup-response-invalid')
  }
  return { found: true, status: 'found', payout }
}

export async function getFincraPayoutByCustomerReference(
  env = process.env,
  customerReference,
  { fetchImpl = globalThis.fetch } = {},
) {
  const result = await lookupFincraPayoutByCustomerReference(env, customerReference, { fetchImpl })
  if (!result.found) {
    const error = new Error('fincra-payout-not-found')
    error.status = 404
    throw error
  }
  return result.payout
}
