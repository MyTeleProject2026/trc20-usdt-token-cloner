import { TronWeb } from 'tronweb'

const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/

function configuredAddress(env, names) {
  for (const name of names) {
    const value = typeof env[name] === 'string' ? env[name].trim() : ''
    if (value) return value
  }
  return null
}

/**
 * Validate public Mainnet wallet identities only.
 *
 * Owner and Sponsor transaction keys live in separate encrypted browser vaults.
 * The Resource API must never read, derive, or require either wallet's private
 * key. Local signing proves control when the wallet signs the exact challenge
 * or prepared transaction; this report is deliberately address-only.
 */
export function createManagedWalletIdentityReport({ env = process.env } = {}) {
  const ownerAddress = configuredAddress(env, ['TRON_OWNER_ADDRESS', 'TRON_OWNER_WALLET_ADDRESS'])
  const sponsorAddress = configuredAddress(env, ['SPONSOR_MAINNET_ADDRESS'])
  const ownerAddressValid = Boolean(ownerAddress && TRON_ADDRESS.test(ownerAddress) && TronWeb.isAddress(ownerAddress))
  const sponsorAddressValid = Boolean(sponsorAddress && TRON_ADDRESS.test(sponsorAddress) && TronWeb.isAddress(sponsorAddress))
  const identitiesDistinct = Boolean(
    ownerAddressValid && sponsorAddressValid
    && ownerAddress !== sponsorAddress,
  )

  return Object.freeze({
    network: 'TRON Mainnet',
    owner: Object.freeze({
      configured: Boolean(ownerAddress),
      addressConfigured: Boolean(ownerAddress),
      address: ownerAddress,
      addressValid: ownerAddressValid,
      signerCustody: 'encrypted-local-owner-vault',
      ready: ownerAddressValid,
    }),
    sponsor: Object.freeze({
      configured: Boolean(sponsorAddress),
      addressConfigured: Boolean(sponsorAddress),
      address: sponsorAddress,
      addressValid: sponsorAddressValid,
      signerCustody: 'encrypted-local-sponsor-vault',
      ready: sponsorAddressValid,
    }),
    identitiesDistinct,
    ready: ownerAddressValid && sponsorAddressValid && identitiesDistinct,
    executionEnabled: false,
  })
}
