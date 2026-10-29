#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isValidTronAddress } from '../server/tron-address.mjs'

const FIREBLOCKS_API_BASES = new Set([
  'https://api.fireblocks.io',
  'https://eu-api.fireblocks.io',
  'https://eu2-api.fireblocks.io',
])
const ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const OWNER_PASSWORD_HASH_PATTERN = /^scrypt\$[A-Za-z0-9_-]{22,86}\$[A-Za-z0-9_-]{86}$/
const ADDRESS_VARIABLE_PATTERN = /^SPONSOR_(?:(?:FEE|ASSET)_)?(?:MAINNET|SHASTA|NILE)_ADDRESS$/
const TOKEN_LIST_VARIABLE_PATTERN = /^SPONSOR_(?:USDT|VTRC)_(?:MAINNET|SHASTA|NILE)_CONTRACTS$/

function present(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function urlIsExactOrigin(value, { allowLocal = false, allowPackaged = false } = {}) {
  try {
    const parsed = new URL(value)
    if (parsed.username || parsed.password || parsed.search || parsed.hash
      || (parsed.pathname !== '' && parsed.pathname !== '/')) return false
    if (parsed.protocol === 'https:') return true
    if (allowLocal && parsed.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname.toLowerCase())) return true
    if (allowPackaged && parsed.protocol === 'tronstudio:' && parsed.host.toLowerCase() === 'app') return true
    return false
  } catch {
    return false
  }
}

function normalizedOriginList(value, options = {}) {
  if (!present(value)) return false
  const entries = value.split(',').map((entry) => entry.trim())
  return entries.length > 0 && entries.every((entry) => urlIsExactOrigin(entry, options))
}

function check(status, detail) {
  return { status, detail }
}

/**
 * Safe environment preflight: reports variable names/status only, never values.
 * It cannot verify account ownership, provider metadata, balances, or settlement.
 */
export function inspectProductionEnvironment(env = process.env, { fileExists = existsSync } = {}) {
  const checks = {}
  const errors = []
  const warnings = []
  const add = (key, result, { error = false, warning = false } = {}) => {
    checks[key] = result
    if (error) errors.push(key)
    if (warning) warnings.push(key)
  }
  const requiredString = (key) => add(key, present(env[key])
    ? check('configured', 'A value is present; remote validity was not checked.')
    : check('missing', 'Add this variable in the backend service.'), { error: !present(env[key]) })

  const databaseValid = (() => {
    if (!present(env.DATABASE_URL)) return false
    try {
      const parsed = new URL(env.DATABASE_URL)
      return ['postgres:', 'postgresql:'].includes(parsed.protocol) && Boolean(parsed.hostname)
    } catch { return false }
  })()
  add('DATABASE_URL', !present(env.DATABASE_URL)
    ? check('missing', 'Set the private Render PostgreSQL connection URL.')
    : databaseValid
      ? check('configured', 'URL syntax only; database connectivity is not tested.')
      : check('invalid', 'Expected a postgres:// or postgresql:// URL.'), { error: !databaseValid })

  requiredString('TATUM_API_KEY')
  add('FRONTEND_ORIGIN', normalizedOriginList(env.FRONTEND_ORIGIN)
    ? check('configured', 'Exact HTTPS origin syntax is valid.')
    : check(present(env.FRONTEND_ORIGIN) ? 'invalid' : 'missing', 'Set the exact hosted frontend HTTPS origin, without a path.'),
  { error: !normalizedOriginList(env.FRONTEND_ORIGIN) })

  const ownerAddressValid = isValidTronAddress(env.OWNER_WALLET_ADDRESS)
  add('OWNER_WALLET_ADDRESS', ownerAddressValid
    ? check('configured', 'Valid TRON Base58Check address; ownership is not proven.')
    : check(present(env.OWNER_WALLET_ADDRESS) ? 'invalid' : 'missing', 'Use the owner-controlled TRON address.')
  , { error: !ownerAddressValid })

  const treasuryOwnerValid = isValidTronAddress(env.TREASURY_OWNER_ADDRESS)
  const ownerMatches = ownerAddressValid && treasuryOwnerValid && env.OWNER_WALLET_ADDRESS === env.TREASURY_OWNER_ADDRESS
  add('TREASURY_OWNER_ADDRESS', !treasuryOwnerValid
    ? check(present(env.TREASURY_OWNER_ADDRESS) ? 'invalid' : 'missing', 'Use the same owner-controlled address as OWNER_WALLET_ADDRESS.')
    : ownerMatches
      ? check('configured', 'Matches OWNER_WALLET_ADDRESS.')
      : check('mismatch', 'Must exactly match OWNER_WALLET_ADDRESS.')
  , { error: !ownerMatches })

  add('OWNER_PASSWORD_HASH', OWNER_PASSWORD_HASH_PATTERN.test(env.OWNER_PASSWORD_HASH || '')
    ? check('configured', 'Hash format matches the owner login scrypt format; password was not tested.')
    : check(present(env.OWNER_PASSWORD_HASH) ? 'invalid' : 'missing', 'Generate locally with node scripts/generate-owner-password-hash.mjs.')
  , { error: !OWNER_PASSWORD_HASH_PATTERN.test(env.OWNER_PASSWORD_HASH || '') })

  const treasuryAddressValid = present(env.TREASURY_ADDRESS) && isValidTronAddress(env.TREASURY_ADDRESS)
  add('TREASURY_ADDRESS', !present(env.TREASURY_ADDRESS)
    ? check('missing', 'Required for managed payouts; do not guess this address.')
    : treasuryAddressValid
      ? check('configured', 'Valid address syntax only; it must match the actual Fireblocks vault address.')
      : check('invalid', 'Must be a valid TRON Base58Check address.')
  , { error: !treasuryAddressValid })

  const positiveDecimal6 = (value) => {
    if (typeof value !== 'string' || value.length > 86
      || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(value)) return false
    const [whole, fraction = ''] = value.split('.')
    if (whole.length > 78) return false
    return BigInt(whole) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6)) > 0n
  }
  for (const key of ['TREASURY_MAX_PAYOUT_USDT', 'TREASURY_DAILY_LIMIT_USDT', 'TREASURY_MAX_PAYOUT_TRX', 'TREASURY_DAILY_LIMIT_TRX']) {
    const valid = positiveDecimal6(env[key])
    add(key, valid
      ? check('configured', 'Positive decimal limit with at most six fractional digits; operator approval is not verified.')
      : check(present(env[key]) ? 'invalid' : 'missing', 'Set a positive decimal payout/daily limit, up to six decimal places.')
    , { error: !valid })
  }

  const feeLimitText = typeof env.TREASURY_FEE_LIMIT_SUN === 'string' ? env.TREASURY_FEE_LIMIT_SUN.trim() : ''
  const feeLimitValid = /^[1-9][0-9]{0,9}$/.test(feeLimitText) && BigInt(feeLimitText || '0') <= 1_000_000_000n
  add('TREASURY_FEE_LIMIT_SUN', feeLimitValid
    ? check('configured', 'Positive integer fee cap in SUN; must be approved and covered by actual TRX.')
    : check(feeLimitText ? 'invalid' : 'missing', 'Set a positive integer fee cap in SUN, no greater than 1000000000.')
  , { error: !feeLimitValid })

  add('TREASURY_SIGNER_MODE', env.TREASURY_SIGNER_MODE === 'fireblocks'
    ? check('configured', 'Managed Fireblocks signer selected.')
    : check(present(env.TREASURY_SIGNER_MODE) ? 'invalid' : 'missing', 'Use fireblocks; the legacy application-held-key path is not an approved payout fallback.')
  , { error: env.TREASURY_SIGNER_MODE !== 'fireblocks' })

  const fireblocksBase = present(env.FIREBLOCKS_API_BASE) ? env.FIREBLOCKS_API_BASE.trim().replace(/\/+$/, '') : 'https://api.fireblocks.io'
  add('FIREBLOCKS_API_BASE', FIREBLOCKS_API_BASES.has(fireblocksBase)
    ? check('configured', 'Supported production API origin syntax.')
    : check('invalid', 'Use the supported production origin confirmed for your Fireblocks workspace.')
  , { error: !FIREBLOCKS_API_BASES.has(fireblocksBase) })

  requiredString('FIREBLOCKS_API_KEY')
  const secretPath = present(env.FIREBLOCKS_SECRET_KEY_PATH) ? env.FIREBLOCKS_SECRET_KEY_PATH.trim() : ''
  const secretFileAvailable = Boolean(secretPath && isAbsolute(secretPath) && fileExists(secretPath))
  add('FIREBLOCKS_SECRET_KEY_PATH', !secretPath
    ? check('missing', 'Set an absolute Render Secret File path.')
    : !isAbsolute(secretPath)
      ? check('invalid', 'Must be an absolute file path.')
      : secretFileAvailable
        ? check('configured', 'The file path exists; PEM validity was not tested.')
        : check('missing-file', 'The path does not exist in this runtime; upload the provider API-user RSA key as a Render Secret File.')
  , { error: !secretFileAvailable })

  add('FIREBLOCKS_VAULT_ACCOUNT_ID', /^\d{1,32}$/.test(env.FIREBLOCKS_VAULT_ACCOUNT_ID || '')
    ? check('configured', 'Numeric vault account ID syntax.')
    : check(present(env.FIREBLOCKS_VAULT_ACCOUNT_ID) ? 'invalid' : 'missing', 'Copy the actual vault account ID from Fireblocks.')
  , { error: !/^\d{1,32}$/.test(env.FIREBLOCKS_VAULT_ACCOUNT_ID || '') })

  for (const key of ['FIREBLOCKS_USDT_ASSET_ID', 'FIREBLOCKS_TRX_ASSET_ID']) {
    add(key, ASSET_ID_PATTERN.test(env[key] || '')
      ? check('configured', 'An asset ID is present; provider metadata was not checked.')
      : check(present(env[key]) ? 'invalid' : 'missing', 'Copy the exact asset ID from the authorized Fireblocks workspace.')
    , { error: !ASSET_ID_PATTERN.test(env[key] || '') })
  }

  for (const key of ['TREASURY_WITHDRAWALS_ENABLED', 'TREASURY_TRX_WITHDRAWALS_ENABLED', 'SPONSOR_MAINNET_BUDGET_ACTIVATION_ENABLED', 'SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED']) {
    const value = typeof env[key] === 'string' ? env[key].trim().toLowerCase() : ''
    const status = value === 'false' || value === ''
      ? check('disabled', 'Safe default; this script never changes flags.')
      : value === 'true'
        ? check('enabled-needs-independent-release-approval', 'Do not treat environment presence as production authorization.')
        : check('invalid', 'Use the literal string true or false.')
    add(key, status, { error: value !== '' && value !== 'false' && value !== 'true', warning: value === 'true' })
  }

  for (const [key, value] of Object.entries(env)) {
    if (ADDRESS_VARIABLE_PATTERN.test(key) && present(value)) {
      add(key, isValidTronAddress(value.trim())
        ? check('configured', 'Valid TRON address syntax; permission and balances are not verified.')
        : check('invalid', 'Must be a valid TRON Base58Check address.')
      , { error: !isValidTronAddress(value.trim()) })
    }
    if (TOKEN_LIST_VARIABLE_PATTERN.test(key) && present(value)) {
      const entries = value.split(',').map((entry) => entry.trim())
      const valid = entries.length > 0 && entries.every(isValidTronAddress)
      add(key, valid
        ? check('configured', 'Address syntax only; token identity and network are not verified.')
        : check('invalid', 'Use a comma-separated list of valid TRON Base58Check contract addresses.')
      , { error: !valid })
    }
  }

  for (const [key, requiredKeys] of [
    ['GASFREE_MAINNET_CREDENTIAL_PAIR', ['GASFREE_MAINNET_API_KEY', 'GASFREE_MAINNET_API_SECRET']],
    ['GASFREE_NILE_CREDENTIAL_PAIR', ['GASFREE_NILE_API_KEY', 'GASFREE_NILE_API_SECRET']],
    ['OKX_API_CREDENTIAL_SET', ['OKX_API_KEY', 'OKX_API_SECRET', 'OKX_API_PASSPHRASE']],
  ]) {
    const count = requiredKeys.filter((name) => present(env[name])).length
    add(key, count === 0
      ? check('not-configured', 'Optional provider integration.')
      : count === requiredKeys.length
        ? check('configured', 'Required credential fields are present; provider access was not tested.')
        : check('incomplete', 'All paired credential fields must be set together.')
    , { error: count > 0 && count !== requiredKeys.length })
  }

  for (const key of ['SPONSOR_ADMIN_API_TOKEN', 'TREASURY_ADMIN_API_TOKEN', 'RECEIVER_WATCHLIST_ADMIN_TOKEN', 'OKX_STATUS_ACCESS_TOKEN']) {
    if (!present(env[key])) continue
    const valid = env[key].length >= 32
    add(key, valid
      ? check('configured', 'Minimum length satisfied; the value itself is never displayed.')
      : check('invalid', 'Use a unique random secret of at least 32 characters.')
    , { error: !valid })
  }

  const optionalOriginChecks = [
    ['PACKAGED_APP_ORIGINS', { allowLocal: true, allowPackaged: true }],
    ['OKX_UI_ORIGIN', {}],
  ]
  for (const [key, options] of optionalOriginChecks) {
    if (!present(env[key])) continue
    const valid = normalizedOriginList(env[key], options)
    add(key, valid ? check('configured', 'Origin syntax is valid.') : check('invalid', 'Use exact origins only, with no paths.')
    , { error: !valid })
  }

  if (present(env.DATABASE_SSL) && !['true', 'false'].includes(env.DATABASE_SSL.trim().toLowerCase())) {
    add('DATABASE_SSL', check('invalid', 'Use true or false.'), { error: true })
  }

  const report = {
    status: errors.length ? 'configuration-needs-attention' : 'syntactic-preflight-passed',
    secretValuesDisplayed: false,
    releaseAuthorized: false,
    checks,
    errors,
    warnings,
    mandatoryLiveChecks: [
      'Verify real provider account authorization, vault ownership, and transaction policy.',
      'Verify Fireblocks USDT metadata matches the official TRON USDT contract and native TRX metadata is correct.',
      'Verify configured treasury address matches the actual provider-returned address for both assets.',
      'Verify provider-available and on-chain principal/fee balances and unresolved payout reservations.',
      'Complete an authorized controlled end-to-end transfer and independently verify its solidified receipt and exact token Transfer event.',
      'Review CI, deployment status, emergency pause, limits, and recovery/reconciliation procedures.',
    ],
  }
  return report
}

function main() {
  const report = inspectProductionEnvironment()
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  if (process.argv.includes('--strict') && (report.errors.length > 0 || report.warnings.length > 0)) {
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
