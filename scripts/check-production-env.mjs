#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { isValidTronAddress } from '../server/tron-address.mjs'

const OWNER_PASSWORD_HASH_PATTERN = /^scrypt\$[A-Za-z0-9_-]{22,86}\$[A-Za-z0-9_-]{86}$/
const ADDRESS_VARIABLE_PATTERN = /^SPONSOR_(?:(?:FEE|ASSET)_)?(?:MAINNET|SHASTA|NILE)_ADDRESS$/
const TOKEN_LIST_VARIABLE_PATTERN = /^SPONSOR_USDT_(?:MAINNET|SHASTA|NILE)_CONTRACTS$/

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
export function inspectProductionEnvironment(env = process.env) {
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

  const fincraPayoutEnabled = env.FINCRA_PAYOUTS_ENABLED === 'true'
  if (fincraPayoutEnabled) {
    const apiBase = present(env.FINCRA_API_BASE) ? env.FINCRA_API_BASE.trim().replace(/\\/+$/, '') : 'https://sandboxapi.fincra.com'
    const approvedFincraBases = new Set(['https://sandboxapi.fincra.com', 'https://api.fincra.com'])
    add('FINCRA_API_BASE', approvedFincraBases.has(apiBase)
      ? check('configured', 'Approved Fincra sandbox or production origin syntax.')
      : check('invalid', 'Use the exact Fincra sandbox or production API origin.')
    , { error: !approvedFincraBases.has(apiBase) })
    requiredString('FINCRA_API_KEY')
    requiredString('FINCRA_BUSINESS_ID')
    requiredString('FINCRA_WEBHOOK_SECRET')
    const sourceCurrency = typeof env.FINCRA_SOURCE_CURRENCY === 'string' ? env.FINCRA_SOURCE_CURRENCY.trim().toUpperCase() : 'USDT'
    add('FINCRA_SOURCE_CURRENCY', sourceCurrency === 'USDT'
      ? check('configured', 'USDT source funding is selected for the USDT TRC20 payout route.')
      : check('unsupported', 'This payout route currently requires a Fincra USDT source wallet; cross-currency quote execution is not enabled.')
    , { error: sourceCurrency !== 'USDT' })
    const positiveDecimal6 = (value) => {
      if (typeof value !== 'string' || value.length > 86
        || !/^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,6})?$/.test(value)) return false
      const [whole, fraction = ''] = value.split('.')
      if (whole.length > 78) return false
      return BigInt(whole) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6)) > 0n
    }
    for (const key of ['FINCRA_MAX_PAYOUT_USDT', 'FINCRA_DAILY_LIMIT_USDT']) {
      const valid = positiveDecimal6(env[key])
      add(key, valid
        ? check('configured', 'Positive USDT limit syntax; funding and business approval are not verified.')
        : check(present(env[key]) ? 'invalid' : 'missing', 'Set a positive USDT limit with at most six decimal places.')
      , { error: !valid })
    }
  } else {
    for (const key of [
      'FINCRA_API_BASE', 'FINCRA_API_KEY', 'FINCRA_BUSINESS_ID',
      'FINCRA_WEBHOOK_SECRET', 'FINCRA_SOURCE_CURRENCY',
      'FINCRA_MAX_PAYOUT_USDT', 'FINCRA_DAILY_LIMIT_USDT',
    ]) {
      add(key, check('not-required-disabled', 'Fincra payouts are disabled; no payout-provider configuration is required.'))
    }
  }

  for (const key of ['FINCRA_PAYOUTS_ENABLED', 'SPONSOR_MAINNET_BUDGET_ACTIVATION_ENABLED', 'SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED']) {
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
