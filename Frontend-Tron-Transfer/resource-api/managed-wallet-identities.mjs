import { TronWeb } from 'tronweb'

const PRIVATE_KEY = /^(?:0x)?[0-9a-fA-F]{64}$/

function readPrivateKey(env, name) {
  const value = typeof env[name] === 'string' ? env[name].trim() : ''
  if (!value) return { key: null, configured: false, validFormat: false }
  if (!PRIVATE_KEY.test(value)) {
    // Keep the API alive so health diagnostics can report a blocked identity.
    // Never include the supplied value in an error or diagnostic.
    return { key: null, configured: true, validFormat: false }
  }
  return { key: value.replace(/^0x/i, ''), configured: true, validFormat: true }
}

function configuredAddress(env, names) {
  for (const name of names) {
    const value = typeof env[name] === 'string' ? env[name].trim() : ''
    if (value) return value
  }
  return null
}

/**
 * Derive backend-managed wallet identities from Render-only private keys.
 *
 * This module deliberately returns public addresses and readiness metadata only.
 * Private keys remain closed over inside this function and are never returned,
 * serialized, logged, or made available to browser-facing API responses.
 *
 * Signing migration is a separate integration step: callers must not treat
 * identity validation as permission to enable transaction execution.
 */
export function createManagedWalletIdentityReport({
  env = process.env,
  deriveAddress = key => TronWeb.address.fromPrivateKey(key),
} = {}) {
  const ownerAddress = configuredAddress(env, ['TRON_OWNER_ADDRESS', 'TRON_OWNER_WALLET_ADDRESS'])
  const sponsorAddress = configuredAddress(env, ['SPONSOR_MAINNET_ADDRESS'])
  const ownerKey = readPrivateKey(env, 'TRON_OWNER_PRIVATE_KEY')
  const sponsorKey = readPrivateKey(env, 'SPONSOR_MAINNET_PRIVATE_KEY')

  let derivedOwnerAddress = null
  let derivedSponsorAddress = null
  try { if (ownerKey.key) derivedOwnerAddress = deriveAddress(ownerKey.key) || null } catch {}
  try { if (sponsorKey.key) derivedSponsorAddress = deriveAddress(sponsorKey.key) || null } catch {}

  const ownerMatches = Boolean(ownerAddress && derivedOwnerAddress && ownerAddress === derivedOwnerAddress)
  const sponsorMatches = Boolean(sponsorAddress && derivedSponsorAddress && sponsorAddress === derivedSponsorAddress)
  const identitiesDistinct = Boolean(
    ownerAddress && sponsorAddress && ownerAddress !== sponsorAddress
    && derivedOwnerAddress && derivedSponsorAddress && derivedOwnerAddress !== derivedSponsorAddress,
  )

  return Object.freeze({
    network: 'TRON Mainnet',
    owner: Object.freeze({
      configured: ownerKey.configured,
      keyFormatValid: ownerKey.validFormat,
      addressConfigured: Boolean(ownerAddress),
      address: ownerAddress,
      derivedAddress: derivedOwnerAddress,
      addressMatches: ownerMatches,
      ready: ownerMatches,
    }),
    sponsor: Object.freeze({
      configured: sponsorKey.configured,
      keyFormatValid: sponsorKey.validFormat,
      addressConfigured: Boolean(sponsorAddress),
      address: sponsorAddress,
      derivedAddress: derivedSponsorAddress,
      addressMatches: sponsorMatches,
      ready: sponsorMatches,
    }),
    identitiesDistinct,
    ready: ownerMatches && sponsorMatches && identitiesDistinct,
    executionEnabled: false,
  })
}
