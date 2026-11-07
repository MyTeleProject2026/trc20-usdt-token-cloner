import { buildSponsorVaultTrustRegistryPins } from '../server/sponsor-vault-trust-registry.mjs'

try {
  const pins = buildSponsorVaultTrustRegistryPins(process.env)
  console.log(JSON.stringify({
    vaultReceiptKeysVersion: process.env.SPONSOR_ORG_VAULT_RECEIPT_KEYS_VERSION || null,
    vaultReceiptKeysSha256: pins.vaultReceiptKeysSha256,
    vaultReceiptKeyCount: pins.vaultReceiptKeyCount,
    scannerAttestationKeysVersion: process.env.SPONSOR_ORG_SCANNER_ATTESTATION_KEYS_VERSION || null,
    scannerAttestationKeysSha256: pins.scannerAttestationKeysSha256,
    scannerAttestationKeyCount: pins.scannerAttestationKeyCount,
    note: 'Store only public Ed25519 keys in the JSON registries. Keep each corresponding private key in its own service key manager. This helper prints no key material and changes no configuration.',
  }, null, 2))
} catch {
  console.error('Vault/scanner trust registry validation failed. Check JSON structure, Ed25519 public-key format and active-key configuration.')
  process.exitCode = 1
}
