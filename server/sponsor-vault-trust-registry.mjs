import { createHash, createPublicKey } from 'node:crypto'

const KEY_ID_RE = /^[A-Za-z0-9._-]{3,128}$/
function sha256(value) { return createHash('sha256').update(value, 'utf8').digest('hex') }

function readRegistry(raw, version, expectedDigest) {
  if (typeof version !== 'string' || !/^[A-Za-z0-9._-]{3,64}$/.test(version.trim())
    || typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedDigest.trim())) {
    return { configured:false, reason:'trust-registry-version-or-digest-pin-missing', version:null, keys:new Map() }
  }
  let parsed
  try { parsed = JSON.parse(String(raw || '')) } catch {
    return { configured:false, reason:'trust-registry-json-invalid', version:version.trim(), keys:new Map() }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { configured:false, reason:'trust-registry-shape-invalid', version:version.trim(), keys:new Map() }
  }
  const entries = Object.entries(parsed)
  if (entries.length < 1 || entries.length > 20) {
    return { configured:false, reason:'trust-registry-entry-count-invalid', version:version.trim(), keys:new Map() }
  }
  const normalized = []
  const keys = new Map()
  for (const [keyId, item] of entries) {
    if (!KEY_ID_RE.test(keyId) || !item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some((key) => !['active','publicKeyPem'].includes(key))
      || typeof item.active !== 'boolean' || typeof item.publicKeyPem !== 'string' || item.publicKeyPem.length > 8192) {
      return { configured:false, reason:'trust-registry-entry-invalid', version:version.trim(), keys:new Map() }
    }
    try {
      const publicKey = createPublicKey(item.publicKeyPem)
      if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('not-ed25519')
    } catch {
      return { configured:false, reason:'trust-registry-public-key-invalid', version:version.trim(), keys:new Map() }
    }
    normalized.push({ keyId, active:item.active, publicKeyPem:item.publicKeyPem })
    keys.set(keyId, { active:item.active, publicKeyPem:item.publicKeyPem })
  }
  normalized.sort((a,b) => a.keyId.localeCompare(b.keyId))
  const actualDigest = sha256(JSON.stringify(normalized))
  if (actualDigest !== expectedDigest.trim().toLowerCase()) {
    return { configured:false, reason:'trust-registry-digest-mismatch', version:version.trim(), digest:actualDigest, keys:new Map() }
  }
  if (!normalized.some((item) => item.active)) {
    return { configured:false, reason:'trust-registry-has-no-active-keys', version:version.trim(), digest:actualDigest, keys:new Map() }
  }
  return { configured:true, reason:null, version:version.trim(), digest:actualDigest, keys }
}

export function getSponsorVaultReceiptKeyRegistry(env = process.env) {
  return readRegistry(env.SPONSOR_ORG_VAULT_RECEIPT_PUBLIC_KEYS,
    env.SPONSOR_ORG_VAULT_RECEIPT_KEYS_VERSION, env.SPONSOR_ORG_VAULT_RECEIPT_KEYS_SHA256)
}
export function getSponsorScannerAttestationKeyRegistry(env = process.env) {
  return readRegistry(env.SPONSOR_ORG_SCANNER_ATTESTATION_PUBLIC_KEYS,
    env.SPONSOR_ORG_SCANNER_ATTESTATION_KEYS_VERSION, env.SPONSOR_ORG_SCANNER_ATTESTATION_KEYS_SHA256)
}

export function buildSponsorVaultTrustRegistryPins(env = process.env) {
  const vault = readRegistryWithoutPin(env.SPONSOR_ORG_VAULT_RECEIPT_PUBLIC_KEYS)
  const scanner = readRegistryWithoutPin(env.SPONSOR_ORG_SCANNER_ATTESTATION_PUBLIC_KEYS)
  return {
    vaultReceiptKeysSha256: sha256(JSON.stringify(vault)),
    vaultReceiptKeyCount: vault.length,
    scannerAttestationKeysSha256: sha256(JSON.stringify(scanner)),
    scannerAttestationKeyCount: scanner.length,
  }
}

function readRegistryWithoutPin(raw) {
  let parsed
  try { parsed = JSON.parse(String(raw || '')) } catch { throw new Error('trust-registry-json-invalid') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('trust-registry-shape-invalid')
  const entries = Object.entries(parsed)
  if (entries.length < 1 || entries.length > 20) throw new Error('trust-registry-entry-count-invalid')
  const normalized = entries.map(([keyId,item]) => {
    if (!KEY_ID_RE.test(keyId) || !item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some((key) => !['active','publicKeyPem'].includes(key))
      || typeof item.active !== 'boolean' || typeof item.publicKeyPem !== 'string' || item.publicKeyPem.length > 8192) {
      throw new Error('trust-registry-entry-invalid')
    }
    const publicKey = createPublicKey(item.publicKeyPem)
    if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('trust-registry-public-key-invalid')
    return { keyId, active:item.active, publicKeyPem:item.publicKeyPem }
  }).sort((a,b) => a.keyId.localeCompare(b.keyId))
  if (!normalized.some((item) => item.active)) throw new Error('trust-registry-has-no-active-keys')
  return normalized
}
