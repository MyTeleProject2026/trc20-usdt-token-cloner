import { createPublicKey, verify as verifySignature } from 'node:crypto'

const SHA256_RE = /^[a-f0-9]{64}$/
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/
const KEY_ID_RE = /^[A-Za-z0-9._-]{3,128}$/

function fail(reason) {
  return { valid: false, reason }
}

// This constrained canonicalizer accepts only JSON primitives, arrays and plain
// objects. Receipt schemas below restrict numeric values to safe integers.
function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('receipt-number-not-safe-integer')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('receipt-json-value-invalid')
  }
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
}

function verifyEnvelope(envelope, keyRegistry, expectedSchema) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return fail('signed-envelope-invalid')
  const signature = envelope.signature
  if (!signature || signature.algorithm !== 'Ed25519' || !KEY_ID_RE.test(String(signature.keyId || ''))
    || typeof signature.value !== 'string' || !BASE64URL_RE.test(signature.value)) return fail('signature-envelope-invalid')
  const key = keyRegistry instanceof Map ? keyRegistry.get(signature.keyId) : keyRegistry?.[signature.keyId]
  if (!key || key.active !== true || typeof key.publicKeyPem !== 'string') return fail('signing-key-not-trusted')
  const payload = { ...envelope }
  delete payload.signature
  if (payload.schema !== expectedSchema) return fail('signed-envelope-schema-unsupported')
  let bytes
  try { bytes = Buffer.from(canonicalJson(payload), 'utf8') } catch { return fail('signed-envelope-canonicalization-failed') }
  let decoded
  try { decoded = Buffer.from(signature.value, 'base64url') } catch { return fail('signature-encoding-invalid') }
  if (decoded.length !== 64 || decoded.toString('base64url') !== signature.value) return fail('signature-encoding-invalid')
  try {
    const publicKey = createPublicKey(key.publicKeyPem)
    if (publicKey.asymmetricKeyType !== 'ed25519' || !verifySignature(null, bytes, publicKey, decoded)) {
      return fail('signature-verification-failed')
    }
  } catch {
    return fail('signature-verification-failed')
  }
  return { valid: true, payload, keyId: signature.keyId }
}

export function verifyMalwareScanAttestation(attestation, {
  keyRegistry, expectedSha256, expectedByteSize, nowMs = Date.now(), maxAgeMs = 5 * 60 * 1000,
} = {}) {
  const verified = verifyEnvelope(attestation, keyRegistry, 'tron-transfer.malware-scan-attestation.v1')
  if (!verified.valid) return verified
  const p = verified.payload
  if (!SHA256_RE.test(String(p.contentSha256 || '')) || p.contentSha256 !== expectedSha256) return fail('scan-attestation-content-hash-mismatch')
  if (!Number.isSafeInteger(p.byteSize) || p.byteSize !== expectedByteSize) return fail('scan-attestation-byte-size-mismatch')
  if (p.result !== 'CLEAN' || p.completed !== true) return fail('scan-attestation-not-clean')
  if (typeof p.scanner !== 'string' || !p.scanner.trim() || typeof p.scannerVersion !== 'string' || !p.scannerVersion.trim()) return fail('scan-attestation-scanner-identity-missing')
  const scannedAt = Date.parse(p.scannedAt)
  if (!Number.isFinite(nowMs) || !Number.isFinite(scannedAt) || scannedAt > nowMs || nowMs - scannedAt > maxAgeMs) return fail('scan-attestation-expired-or-invalid-time')
  if (typeof p.attestationId !== 'string' || !p.attestationId.trim()) return fail('scan-attestation-id-missing')
  return { valid: true, status: 'clean-attestation-verified', attestationId: p.attestationId, keyId: verified.keyId,
    scanner:p.scanner, scannerVersion:p.scannerVersion, scannedAt:p.scannedAt }
}

export function verifyPrivateVaultReceiptV2(receipt, {
  keyRegistry, expectedObjectKey, expectedSha256, expectedByteSize, expectedMediaType,
  expectedOrganizationId, expectedIssuer, expectedRetentionPolicyReference, minimumRetentionMs = 0,
  scannerKeyRegistry, expectedAudience = 'tron-transfer-onboarding', nowMs = Date.now(),
} = {}) {
  const verified = verifyEnvelope(receipt, keyRegistry, 'tron-transfer.private-vault-receipt.v2')
  if (!verified.valid) return verified
  const p = verified.payload
  if (p.audience !== expectedAudience || typeof p.issuer !== 'string' || !p.issuer.trim()
    || (expectedIssuer && p.issuer !== expectedIssuer)) return fail('vault-receipt-issuer-or-audience-invalid')
  if (typeof p.receiptId !== 'string' || !p.receiptId.trim()) return fail('vault-receipt-id-missing')
  const issuedAt = Date.parse(p.issuedAt)
  if (!Number.isFinite(issuedAt) || !Number.isFinite(nowMs) || issuedAt > nowMs + 30000 || nowMs - issuedAt > 10 * 60 * 1000) return fail('vault-receipt-issued-at-invalid-or-stale')
  if (p.organizationId !== expectedOrganizationId) return fail('vault-receipt-organization-mismatch')
  if (!p.object || p.object.objectKey !== expectedObjectKey || p.object.sha256 !== expectedSha256
    || p.object.byteSize !== expectedByteSize || p.object.mediaType !== expectedMediaType) return fail('vault-receipt-object-binding-mismatch')
  if (!SHA256_RE.test(String(p.object.sha256 || '')) || !Number.isSafeInteger(p.object.byteSize) || p.object.byteSize < 1) return fail('vault-receipt-object-metadata-invalid')
  if (typeof p.object.versionId !== 'string' || !p.object.versionId.trim()) return fail('vault-receipt-version-missing')
  if (!p.storage || p.storage.provider !== 'aws-s3' || !p.storage.encryption
    || p.storage.encryption.verified !== true || p.storage.encryption.mode !== 'SSE-KMS'
    || typeof p.storage.encryption.keyReference !== 'string' || !p.storage.encryption.keyReference.trim()) {
    return fail('vault-receipt-encryption-not-verified')
  }
  const retention = p.storage.retention
  if (!retention || retention.verified !== true || !['GOVERNANCE', 'COMPLIANCE'].includes(retention.mode)
    || typeof retention.policyReference !== 'string' || !retention.policyReference.trim()
    || (expectedRetentionPolicyReference && retention.policyReference !== expectedRetentionPolicyReference)) return fail('vault-receipt-retention-not-verified')
  const retainUntil = Date.parse(retention.retainUntil)
  if (!Number.isFinite(retainUntil) || retainUntil <= nowMs
    || !Number.isFinite(minimumRetentionMs) || minimumRetentionMs < 0
    || retainUntil < issuedAt + minimumRetentionMs) return fail('vault-receipt-retention-expired-or-insufficient')
  const scan = verifyMalwareScanAttestation(p.malwareScan?.attestation, {
    keyRegistry: scannerKeyRegistry,
    expectedSha256, expectedByteSize, nowMs,
  })
  if (!scan.valid) return fail('vault-receipt-malware-attestation-invalid')
  if (p.malwareScan?.verified !== true || p.malwareScan?.result !== 'CLEAN'
    || p.malwareScan.scanner !== scan.scanner || p.malwareScan.scannerVersion !== scan.scannerVersion
    || p.malwareScan.scannedAt !== scan.scannedAt) return fail('vault-receipt-malware-scan-not-verified')
  return {
    valid: true,
    status: 'private-vault-receipt-v2-verified',
    receiptId: p.receiptId,
    objectVersionId: p.object.versionId,
    retentionMode: retention.mode,
    retainUntil: retention.retainUntil,
    encryptionMode: p.storage.encryption.mode,
    signingKeyId: verified.keyId,
    payoutAuthorized: false,
  }
}
