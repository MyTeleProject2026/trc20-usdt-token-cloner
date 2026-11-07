import { createHash, createPublicKey } from 'node:crypto'

const KEY_ID_RE = /^[A-Za-z0-9._-]{3,128}$/
const VERSION_RE = /^[A-Za-z0-9._-]{3,64}$/
const DIGEST_RE = /^[a-f0-9]{64}$/
const MAX_KEYS = 20
const MAX_REVOCATIONS = 500

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function unavailable(reason, version = null) {
  return Object.freeze({ configured: false, reason, version, checkedAtMs: Date.now(), trustedKeys: new Map(), revokedKeyIds: Object.freeze([]) })
}

function canonicalKeys(raw) {
  let parsed
  try { parsed = JSON.parse(String(raw || '')) } catch { throw new Error('financial-vault-trust-json-invalid') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('financial-vault-trust-shape-invalid')
  const entries = Object.entries(parsed)
  if (entries.length < 1 || entries.length > MAX_KEYS) throw new Error('financial-vault-trust-key-count-invalid')
  const normalized = entries.map(([keyId, item]) => {
    if (!KEY_ID_RE.test(keyId) || !item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).sort().join(',') !== 'audiences,issuer,notAfterMs,notBeforeMs,publicKeyPem,status'
      || !['active', 'inactive'].includes(item.status)
      || typeof item.issuer !== 'string' || !item.issuer.trim() || item.issuer.length > 200
      || !Array.isArray(item.audiences) || item.audiences.length < 1 || item.audiences.length > 10
      || item.audiences.some((audience) => typeof audience !== 'string' || !audience.trim() || audience.length > 200)
      || new Set(item.audiences).size !== item.audiences.length
      || typeof item.publicKeyPem !== 'string' || item.publicKeyPem.length > 8192
      || !Number.isSafeInteger(item.notBeforeMs) || !Number.isSafeInteger(item.notAfterMs)
      || item.notBeforeMs <= 0 || item.notAfterMs <= item.notBeforeMs) {
      throw new Error('financial-vault-trust-key-invalid')
    }
    const publicKey = createPublicKey(item.publicKeyPem)
    if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('financial-vault-trust-key-not-ed25519')
    return { keyId, status: item.status, issuer: item.issuer, audiences: [...item.audiences].sort(),
      publicKeyPem: item.publicKeyPem, notBeforeMs: item.notBeforeMs, notAfterMs: item.notAfterMs }
  }).sort((a, b) => a.keyId.localeCompare(b.keyId))
  if (!normalized.some((key) => key.status === 'active')) throw new Error('financial-vault-trust-no-active-keys')
  return normalized
}

function canonicalRevocations(raw) {
  let parsed
  try { parsed = JSON.parse(String(raw || '')) } catch { throw new Error('financial-vault-revocations-json-invalid') }
  if (!Array.isArray(parsed) || parsed.length > MAX_REVOCATIONS
    || parsed.some((id) => typeof id !== 'string' || !KEY_ID_RE.test(id))
    || new Set(parsed).size !== parsed.length) throw new Error('financial-vault-revocations-invalid')
  return [...parsed].sort()
}

/**
 * Dedicated trust snapshot for financial Treasury Vault observations.
 * This registry is intentionally separate from organizational sponsor keys.
 * Pins are mandatory; this module never provisions keys or changes environment.
 */
export function getPrivateTreasuryVaultFinancialTrustRegistry(env = process.env, nowMs = Date.now()) {
  const version = typeof env.PRIVATE_TREASURY_VAULT_TRUST_VERSION === 'string'
    ? env.PRIVATE_TREASURY_VAULT_TRUST_VERSION.trim() : ''
  const expectedKeysDigest = typeof env.PRIVATE_TREASURY_VAULT_TRUST_SHA256 === 'string'
    ? env.PRIVATE_TREASURY_VAULT_TRUST_SHA256.trim().toLowerCase() : ''
  const expectedRevocationsDigest = typeof env.PRIVATE_TREASURY_VAULT_REVOCATIONS_SHA256 === 'string'
    ? env.PRIVATE_TREASURY_VAULT_REVOCATIONS_SHA256.trim().toLowerCase() : ''
  if (!VERSION_RE.test(version) || !DIGEST_RE.test(expectedKeysDigest) || !DIGEST_RE.test(expectedRevocationsDigest)
    || !Number.isSafeInteger(nowMs) || nowMs <= 0) return unavailable('financial-vault-trust-pins-missing-or-invalid', version || null)

  try {
    const keys = canonicalKeys(env.PRIVATE_TREASURY_VAULT_TRUSTED_KEYS_JSON)
    const revocations = canonicalRevocations(env.PRIVATE_TREASURY_VAULT_REVOKED_KEY_IDS_JSON || '[]')
    const keysDigest = sha256(JSON.stringify(keys))
    const revocationsDigest = sha256(JSON.stringify(revocations))
    if (keysDigest !== expectedKeysDigest) return unavailable('financial-vault-trust-digest-mismatch', version)
    if (revocationsDigest !== expectedRevocationsDigest) return unavailable('financial-vault-revocations-digest-mismatch', version)
    const trustedKeys = new Map(keys.map(({ keyId, ...record }) => [keyId, Object.freeze(record)]))
    return Object.freeze({
      configured: true, reason: null, version, keysDigest, revocationsDigest,
      checkedAtMs: nowMs, trustedKeys, revokedKeyIds: Object.freeze(revocations),
    })
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : 'financial-vault-trust-invalid', version)
  }
}
