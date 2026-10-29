import { createHash, createPrivateKey, randomBytes, sign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

const DEFAULT_API_BASE = 'https://api.fireblocks.io'
const ALLOWED_API_BASES = new Set([
  'https://api.fireblocks.io',
  'https://eu-api.fireblocks.io',
  'https://eu2-api.fireblocks.io',
])
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const TXID_PATTERN = /^[0-9a-f]{64}$/i

export class FireblocksApiError extends Error {
  constructor(status, code = 'fireblocks-provider-error') {
    super(code)
    this.name = 'FireblocksApiError'
    this.status = status
    this.code = code
  }
}

function base64url(value) {
  return Buffer.from(value).toString('base64url')
}

export function fireblocksConfiguration(env = process.env) {
  const apiKey = typeof env.FIREBLOCKS_API_KEY === 'string' ? env.FIREBLOCKS_API_KEY.trim() : ''
  const secretKeyPath = typeof env.FIREBLOCKS_SECRET_KEY_PATH === 'string' ? env.FIREBLOCKS_SECRET_KEY_PATH.trim() : ''
  const vaultAccountId = typeof env.FIREBLOCKS_VAULT_ACCOUNT_ID === 'string' ? env.FIREBLOCKS_VAULT_ACCOUNT_ID.trim() : ''
  const usdtAssetId = typeof env.FIREBLOCKS_USDT_ASSET_ID === 'string' ? env.FIREBLOCKS_USDT_ASSET_ID.trim() : ''
  const apiBaseInput = typeof env.FIREBLOCKS_API_BASE === 'string' && env.FIREBLOCKS_API_BASE.trim()
    ? env.FIREBLOCKS_API_BASE.trim().replace(/\/+$/, '')
    : DEFAULT_API_BASE
  const missing = []
  if (!apiKey) missing.push('FIREBLOCKS_API_KEY')
  // This is the Fireblocks API-user RSA credential, not a blockchain wallet key.
  // Transaction signing is performed by Fireblocks custody infrastructure.
  if (!secretKeyPath || !isAbsolute(secretKeyPath)) missing.push('FIREBLOCKS_SECRET_KEY_PATH')
  if (!/^\d{1,32}$/.test(vaultAccountId)) missing.push('FIREBLOCKS_VAULT_ACCOUNT_ID')
  if (!IDENTIFIER_PATTERN.test(usdtAssetId)) missing.push('FIREBLOCKS_USDT_ASSET_ID')
  if (!ALLOWED_API_BASES.has(apiBaseInput)) missing.push('FIREBLOCKS_API_BASE (unsupported production URL)')
  return {
    configured: missing.length === 0,
    missing,
    apiKey,
    secretKeyPath,
    vaultAccountId,
    usdtAssetId,
    apiBase: apiBaseInput,
  }
}

/**
 * Fireblocks REST JWT authentication. secretKey is the API-user RSA key issued
 * by Fireblocks, not a blockchain signing key. Wallet transaction signatures
 * are performed by Fireblocks custody infrastructure.
 */
export function createFireblocksJwt({
  apiKey,
  secretKey,
  uri,
  body = '',
  now = Date.now(),
  nonce = randomBytes(16).toString('hex'),
} = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()
    || typeof uri !== 'string' || !uri.startsWith('/v1/')
    || uri.includes('://') || uri.includes('#')
    || typeof body !== 'string') {
    throw new TypeError('Invalid Fireblocks request-authentication input.')
  }
  const issuedAt = Math.floor(Number(now) / 1000)
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) throw new TypeError('Invalid Fireblocks JWT clock.')
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64url(JSON.stringify({
    uri,
    nonce: String(nonce),
    iat: issuedAt,
    exp: issuedAt + 20,
    sub: apiKey.trim(),
    bodyHash: createHash('sha256').update(body, 'utf8').digest('hex'),
  }))
  const unsigned = header + '.' + payload
  let privateKey
  try {
    privateKey = createPrivateKey(secretKey)
  } catch {
    throw new Error('Fireblocks API authentication secret file is not a readable PEM private key.')
  }
  const signature = sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')
  return unsigned + '.' + signature
}

function unwrapResponse(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && value.data && typeof value.data === 'object') {
    return value.data
  }
  return value
}

export function extractFireblocksAddresses(value) {
  const candidates = [
    Array.isArray(value) ? value : null,
    value?.addresses,
    value?.data?.addresses,
    value?.data,
    value?.items,
  ]
  const rows = candidates.find(Array.isArray) || []
  return rows.map((item) => {
    if (typeof item === 'string') return item
    if (!item || typeof item !== 'object') return ''
    return typeof item.address === 'string' ? item.address
      : typeof item.addressString === 'string' ? item.addressString
        : typeof item.address_string === 'string' ? item.address_string : ''
  }).filter(Boolean)
}

export function providerAssetAvailableBaseUnits(assetResponse) {
  if (!assetResponse || typeof assetResponse !== 'object') return null
  // Fireblocks "available" excludes funds locked by other transactions. Accept
  // zero as a valid reading, but reject exponent notation, excess precision,
  // malformed values and uint256 overflow.
  const amount = typeof assetResponse.available === 'string'
    ? assetResponse.available.trim()
    : typeof assetResponse.available === 'number' && Number.isFinite(assetResponse.available)
      ? String(assetResponse.available) : ''
  if (!/^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,6})?$/.test(amount)) return null
  const [whole, fraction = ''] = amount.split('.')
  if (whole.length > 78) return null
  const units = BigInt(whole) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6))
  return units <= ((1n << 256n) - 1n) ? units.toString() : null
}

export function isOfficialFireblocksUsdtAsset(assetResponse, tronWeb, officialAddress) {
  if (!assetResponse || typeof assetResponse !== 'object'
    || !tronWeb?.address?.toHex || typeof officialAddress !== 'string') return false
  const fields = [
    assetResponse.contractAddress,
    assetResponse.contract_address,
    assetResponse.contract?.address,
    assetResponse.details?.contractAddress,
  ].filter((value) => typeof value === 'string' && value.trim())
  if (fields.length === 0) return false
  try {
    const expected = String(tronWeb.address.toHex(officialAddress)).replace(/^0x/i, '').toLowerCase()
    return fields.some((field) => {
      const value = field.trim()
      const asHex = /^(?:0x)?41[0-9a-f]{40}$/i.test(value)
        ? value.replace(/^0x/i, '').toLowerCase()
        : (() => {
            try { return String(tronWeb.address.toHex(value)).replace(/^0x/i, '').toLowerCase() } catch { return '' }
          })()
      return asHex === expected
    })
  } catch {
    return false
  }
}

export function classifyFireblocksTransaction(transaction) {
  const providerStatus = typeof transaction?.status === 'string' ? transaction.status.toUpperCase() : 'UNKNOWN'
  const rawHash = typeof transaction?.txHash === 'string' ? transaction.txHash.trim() : ''
  const transactionHash = TXID_PATTERN.test(rawHash) ? rawHash.toLowerCase() : null
  const terminalFailure = new Set(['FAILED', 'CANCELLED', 'REJECTED', 'BLOCKED']).has(providerStatus)
  // A provider-supplied chain hash must still pass the independent TRON receipt verifier.
  const localStatus = transactionHash
    ? 'broadcast-accepted'
    : terminalFailure ? 'failed' : 'provider-pending'
  return { providerStatus, transactionHash, localStatus, terminalFailure }
}

/**
 * Strict production-only Fireblocks client for a pre-existing, operator-owned
 * vault account. It never creates vaults, approves policies, or accepts a wallet
 * private key. Use an API-user RSA key mounted as a backend secret file.
 */
export function createFireblocksClient(env = process.env, {
  fetchImpl = globalThis.fetch,
  readSecretFile = readFile,
  now = () => Date.now(),
  nonceFactory = () => randomBytes(16).toString('hex'),
} = {}) {
  const config = fireblocksConfiguration(env)

  async function request(method, uri, payload) {
    if (!config.configured) throw new FireblocksApiError(503, 'fireblocks-not-configured')
    if (typeof fetchImpl !== 'function') throw new FireblocksApiError(503, 'fetch-unavailable')
    if (typeof uri !== 'string' || !uri.startsWith('/v1/') || uri.includes('://') || uri.includes('#')) {
      throw new FireblocksApiError(400, 'invalid-fireblocks-path')
    }
    const body = payload === undefined ? '' : JSON.stringify(payload)
    let pem
    try {
      pem = await readSecretFile(config.secretKeyPath, 'utf8')
    } catch {
      throw new FireblocksApiError(503, 'fireblocks-api-key-file-unavailable')
    }
    let token
    try {
      token = createFireblocksJwt({
        apiKey: config.apiKey,
        secretKey: pem,
        uri,
        body,
        now: now(),
        nonce: nonceFactory(),
      })
    } catch {
      throw new FireblocksApiError(503, 'fireblocks-authentication-unavailable')
    }
    let response
    try {
      response = await fetchImpl(config.apiBase + uri, {
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-API-Key': config.apiKey,
          Authorization: 'Bearer ' + token,
        },
        ...(payload === undefined ? {} : { body }),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      throw new FireblocksApiError(502, 'fireblocks-provider-unreachable')
    }
    let responseText
    try { responseText = await response.text() } catch {
      throw new FireblocksApiError(502, 'fireblocks-invalid-response')
    }
    if (Buffer.byteLength(responseText, 'utf8') > 512 * 1024) {
      throw new FireblocksApiError(502, 'fireblocks-response-too-large')
    }
    let parsed = {}
    if (responseText) {
      try { parsed = JSON.parse(responseText) } catch {
        throw new FireblocksApiError(502, 'fireblocks-invalid-response')
      }
    }
    if (!response.ok) {
      // Provider response text and policy internals are deliberately not returned.
      throw new FireblocksApiError(response.status, 'fireblocks-provider-http-error')
    }
    return unwrapResponse(parsed)
  }

  return Object.freeze({
    isConfigured: () => config.configured,
    configuration: () => ({ configured: config.configured, missing: [...config.missing], apiBase: config.apiBase }),
    async getVaultAccountAsset() {
      return request('GET', '/v1/vault/accounts/' + encodeURIComponent(config.vaultAccountId) + '/' + encodeURIComponent(config.usdtAssetId))
    },
    async getAssetMetadata() {
      return request('GET', '/v1/vault/assets/' + encodeURIComponent(config.usdtAssetId))
    },
    async getAssetAddresses() {
      return request('GET', '/v1/vault/accounts/' + encodeURIComponent(config.vaultAccountId) + '/' + encodeURIComponent(config.usdtAssetId) + '/addresses')
    },
    async createUsdtTransfer({ recipientAddress, amountUsdt, externalTxId, note } = {}) {
      if (typeof recipientAddress !== 'string' || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(recipientAddress)
        || typeof amountUsdt !== 'string' || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(amountUsdt)
        || !IDENTIFIER_PATTERN.test(externalTxId || '')) {
        throw new FireblocksApiError(400, 'invalid-fireblocks-transfer-request')
      }
      const requestBody = {
        operation: 'TRANSFER',
        assetId: config.usdtAssetId,
        source: { type: 'VAULT_ACCOUNT', id: config.vaultAccountId },
        destination: { type: 'ONE_TIME_ADDRESS', oneTimeAddress: { address: recipientAddress } },
        amount: amountUsdt,
        externalTxId,
        note: typeof note === 'string' ? note.slice(0, 180) : 'TRON Token Studio treasury payout',
      }
      return request('POST', '/v1/transactions', requestBody)
    },
    async getTransaction(transactionId) {
      if (typeof transactionId !== 'string' || !IDENTIFIER_PATTERN.test(transactionId)) {
        throw new FireblocksApiError(400, 'invalid-fireblocks-transaction-id')
      }
      return request('GET', '/v1/transactions/' + encodeURIComponent(transactionId))
    },
    async findTransactionByExternalId(externalTxId) {
      if (!IDENTIFIER_PATTERN.test(externalTxId || '')) throw new FireblocksApiError(400, 'invalid-fireblocks-external-id')
      return request('GET', '/v1/transactions/external_tx_id/' + encodeURIComponent(externalTxId))
    },
  })
}

export default createFireblocksClient
