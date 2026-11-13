import { isValidTronAddress } from './tron-address.mjs'

/**
 * The supplied Ripple OpenAPI document has no Bitpie endpoints. This adapter
 * intentionally exposes address-format validation only; it never invents a
 * Bitpie balance-write, deposit, notification, or wallet-control API.
 */
export function createBitpieAdapter() {
  const capabilities = Object.freeze({
    provider: 'Bitpie',
    integrationStatus: 'unsupported-public-api-not-established',
    supported: ['validate-tron-address-format'],
    unsupported: ['read-bitpie-account-balance', 'create-bitpie-deposit', 'write-bitpie-wallet-balance', 'send-bitpie-notification'],
    disclosure: 'Tron Transfer internal credits are not Bitpie wallet assets or deposits.',
  })
  return Object.freeze({
    capabilities,
    validateTronAddress(address) {
      return {
        validFormat: typeof address === 'string' && isValidTronAddress(address.trim()),
        network: 'TRON',
        ownershipVerified: false,
        bitpieAccountVerified: false,
      }
    },
    async getBalance() { return { supported: false, error: 'bitpie-balance-api-not-established' } },
    async createDeposit() { return { supported: false, error: 'bitpie-deposit-api-not-established' } },
    async writeWalletBalance() { return { supported: false, error: 'bitpie-wallet-balance-write-not-supported' } },
  })
}
