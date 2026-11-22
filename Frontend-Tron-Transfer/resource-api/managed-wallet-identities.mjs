import { TronWeb } from 'tronweb'

const PRIVATE_KEY = /^(?:0x)?[0-9a-fA-F]{64}$/

function readPrivateKey(env, name) {
  const value = typeof env[name] === 'string' ? env[name].trim() : ''
  if (!value) return null
  if (!PRIVATE_KEY.test(value)) {
    // Never include the supplied value in an error or diagnostic.
    throw new Error(name + '-invalid-format')
  }
  return value.replace(/^0x/i, '')
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
  if (ownerKey) derivedOwnerAddress = deriveAddress(ownerKey) || null
  if (sponsorKey) derivedSponsorAddress = deriveAddress(sponsorKey) || null

  const ownerMatches = Boolean(ownerAddress && derivedOwnerAddress && ownerAddress === derivedOwnerAddress)
  const sponsorMatches = Boolean(sponsorAddress && derivedSponsorAddress && sponsorAddress === derivedSponsorAddress)
  const identitiesDistinct = Boolean(
    ownerAddress && sponsorAddress && ownerAddress !== sponsorAddress
    && derivedOwnerAddress && derivedSponsorAddress && derivedOwnerAddress !== derivedSponsorAddress,
  )

  return Object.freeze({
    network: 'TRON Mainnet',
    owner: Object.freeze({
      configured: Boolean(ownerKey),
      addressConfigured: Boolean(ownerAddress),
      address: ownerAddress,
      derivedAddress: derivedOwnerAddress,
      addressMatches: ownerMatches,
      ready: ownerMatches,
    }),
    sponsor: Object.freeze({
      configured: Boolean(sponsorKey),
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
