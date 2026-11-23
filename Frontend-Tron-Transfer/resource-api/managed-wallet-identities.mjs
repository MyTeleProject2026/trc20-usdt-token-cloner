import { TronWeb } from 'tronweb'

const PRIVATE_KEY = /^(?:0x)?[0-9a-fA-F]{64}$/
const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/

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
 * Validate the public Owner address and the independently managed Sponsor
 * signer. Owner transaction custody is TronLink; the Resource API never reads
 * or derives an Owner private key. Sponsor signing remains server-side.
 */
export function createManagedWalletIdentityReport({
  env = process.env,
  deriveAddress = key => TronWeb.address.fromPrivateKey(key),
} = {}) {
  const ownerAddress = configuredAddress(env, ['TRON_OWNER_ADDRESS', 'TRON_OWNER_WALLET_ADDRESS'])
  const sponsorAddress = configuredAddress(env, ['SPONSOR_MAINNET_ADDRESS'])
  const ownerAddressValid = Boolean(ownerAddress && TRON_ADDRESS.test(ownerAddress))
  const sponsorKey = readPrivateKey(env, 'SPONSOR_MAINNET_PRIVATE_KEY')

  let derivedSponsorAddress = null
  try { if (sponsorKey.key) derivedSponsorAddress = deriveAddress(sponsorKey.key) || null } catch {}

  const sponsorMatches = Boolean(
    sponsorAddress && TRON_ADDRESS.test(sponsorAddress)
    && derivedSponsorAddress && sponsorAddress === derivedSponsorAddress,
  )
  const identitiesDistinct = Boolean(
    ownerAddressValid && sponsorMatches
    && ownerAddress !== sponsorAddress
    && ownerAddress !== derivedSponsorAddress,
  )

  return Object.freeze({
    network: 'TRON Mainnet',
    owner: Object.freeze({
      configured: Boolean(ownerAddress),
      addressConfigured: Boolean(ownerAddress),
      address: ownerAddress,
      addressValid: ownerAddressValid,
      signerCustody: 'tronlink',
      ready: ownerAddressValid,
    }),
    sponsor: Object.freeze({
      configured: sponsorKey.configured,
      keyFormatValid: sponsorKey.validFormat,
      addressConfigured: Boolean(sponsorAddress),
      address: sponsorAddress,
      derivedAddress: derivedSponsorAddress,
      addressMatches: sponsorMatches,
      signerCustody: 'resource-api',
      ready: sponsorMatches,
    }),
    identitiesDistinct,
    ready: ownerAddressValid && sponsorMatches && identitiesDistinct,
    executionEnabled: false,
  })
}
