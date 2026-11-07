import net from 'node:net'
import {
  getSponsorVaultReceiptKeyRegistry,
  getSponsorScannerAttestationKeyRegistry,
} from './sponsor-vault-trust-registry.mjs'
import {
  verifyMalwareScanAttestation,
  verifyPrivateVaultReceiptV2,
} from './sponsor-vault-receipt-v2.mjs'
import { validateEvidenceBytes } from './sponsor-document-custody.mjs'

function clean(value, max = 512) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function approvedHttpsOrigin(raw, allowedRaw) {
  let url
  try { url = new URL(raw) } catch { return null }
  const host = url.hostname.toLowerCase()
  const allow = String(allowedRaw || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || !allow.includes(host) || net.isIP(host) !== 0
    || /^(localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i.test(host)
    || /^(127\.|0\.|169\.254\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(host)) return null
  return url.origin + url.pathname.replace(/\/$/, '')
}

export function getDocumentCustodyV2Config(env = process.env) {
  const scannerBase = approvedHttpsOrigin(env.SPONSOR_ORG_SCANNER_ATTESTATION_API_BASE, env.SPONSOR_ORG_SCANNER_ATTESTATION_ALLOWED_HOSTS)
  const vaultBase = approvedHttpsOrigin(env.SPONSOR_ORG_VAULT_API_BASE, env.SPONSOR_ORG_VAULT_ALLOWED_HOSTS)
  const scannerToken = clean(env.SPONSOR_ORG_SCANNER_ATTESTATION_API_TOKEN, 4096)
  const vaultToken = clean(env.SPONSOR_ORG_VAULT_API_TOKEN, 4096)
  const scannerName = clean(env.SPONSOR_ORG_SCANNER_NAME, 80)
  const scannerVersionPrefix = clean(env.SPONSOR_ORG_SCANNER_VERSION_PREFIX, 100)
  const vaultIssuer = clean(env.SPONSOR_ORG_VAULT_RECEIPT_ISSUER, 128)
  const minRetentionDays = Number(env.SPONSOR_ORG_VAULT_MIN_RETENTION_DAYS)
  const vaultKeys = getSponsorVaultReceiptKeyRegistry(env)
  const scannerKeys = getSponsorScannerAttestationKeyRegistry(env)
  const missing = []
  if (!scannerBase) missing.push('scanner-attestation-origin-or-allowlist-invalid')
  if (!vaultBase) missing.push('vault-origin-or-allowlist-invalid')
  if (scannerToken.length < 32) missing.push('scanner-attestation-service-token-missing')
  if (vaultToken.length < 32) missing.push('vault-service-token-missing')
  if (!scannerName || !scannerVersionPrefix) missing.push('scanner-identity-not-pinned')
  if (!vaultIssuer) missing.push('vault-receipt-issuer-not-configured')
  if (!Number.isInteger(minRetentionDays) || minRetentionDays < 1 || minRetentionDays > 3650) missing.push('vault-minimum-retention-days-invalid')
  if (!vaultKeys.configured) missing.push('vault-receipt-public-key-registry-not-ready')
  if (!scannerKeys.configured) missing.push('scanner-attestation-public-key-registry-not-ready')
  return {
    ready: missing.length === 0,
    missing,
    scannerBase, scannerToken, scannerName, scannerVersionPrefix,
    vaultBase, vaultToken, vaultIssuer, minRetentionDays,
    vaultKeys: vaultKeys.keys, vaultKeyRegistryVersion: vaultKeys.version,
    scannerKeys: scannerKeys.keys, scannerKeyRegistryVersion: scannerKeys.version,
  }
}

async function readJson(response, errorCode) {
  if (!response.ok) throw new Error(errorCode)
  try { return await response.json() } catch { throw new Error(errorCode) }
}

export async function scanAndStoreEvidenceV2({
  buffer, mediaType, retentionPolicyReference, applicationId, mandateId,
  config, fetchImpl = fetch, now = () => Date.now(),
} = {}) {
  if (!config?.ready) throw new Error('document-custody-v2-not-configured')
  const metadata = validateEvidenceBytes(buffer, mediaType)
  const scannerResponse = await fetchImpl(config.scannerBase + '/v1/scans', {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
    headers: {
      Authorization: 'Bearer ' + config.scannerToken,
      'Content-Type': mediaType,
      'Content-Length': String(buffer.length),
      'X-Content-SHA256': metadata.contentSha256,
      'X-Organization-Id': applicationId,
      'X-Mandate-Id': mandateId,
    },
    body: buffer,
  }).catch(() => { throw new Error('independent-scanner-service-unavailable') })
  const scannerBody = await readJson(scannerResponse, 'independent-scanner-service-rejected')
  const attestation = scannerBody?.attestation
  const scanVerification = verifyMalwareScanAttestation(attestation, {
    keyRegistry: config.scannerKeys,
    expectedSha256: metadata.contentSha256,
    expectedByteSize: metadata.byteSize,
    nowMs: now(),
  })
  if (!scanVerification.valid) throw new Error('independent-scan-attestation-invalid')
  const attestationPayload = attestation
  if (attestationPayload.scanner !== config.scannerName
    || !String(attestationPayload.scannerVersion || '').startsWith(config.scannerVersionPrefix)) {
    throw new Error('independent-scan-identity-mismatch')
  }
  const objectKey = 'sponsor-evidence/' + applicationId + '/' + mandateId + '/' + scanVerification.attestationId
  const attestationHeader = Buffer.from(JSON.stringify(attestation), 'utf8').toString('base64url')
  const vaultResponse = await fetchImpl(config.vaultBase + '/v2/objects/' + objectKey.split('/').map(encodeURIComponent).join('/'), {
    method: 'PUT',
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
    headers: {
      Authorization: 'Bearer ' + config.vaultToken,
      'Content-Type': mediaType,
      'Content-Length': String(buffer.length),
      'X-Content-SHA256': metadata.contentSha256,
      'X-Organization-Id': applicationId,
      'X-Retention-Policy-Reference': retentionPolicyReference,
      'X-Scan-Attestation': attestationHeader,
    },
    body: buffer,
  }).catch(() => { throw new Error('private-vault-upload-unavailable') })
  const vaultBody = await readJson(vaultResponse, 'private-vault-upload-rejected')
  const receipt = vaultBody?.receipt
  const verification = verifyPrivateVaultReceiptV2(receipt, {
    keyRegistry: config.vaultKeys,
    scannerKeyRegistry: config.scannerKeys,
    expectedObjectKey: objectKey,
    expectedSha256: metadata.contentSha256,
    expectedByteSize: metadata.byteSize,
    expectedMediaType: mediaType,
    expectedOrganizationId: applicationId,
    expectedIssuer: config.vaultIssuer,
    minimumRetentionMs: config.minRetentionDays * 24 * 60 * 60 * 1000,
    nowMs: now(),
  })
  if (!verification.valid) throw new Error('private-vault-receipt-v2-invalid')
  if (receipt.malwareScan?.attestation?.signature?.value !== attestation.signature.value
    || receipt.malwareScan?.attestation?.signature?.keyId !== attestation.signature.keyId) {
    throw new Error('vault-receipt-scanner-attestation-substitution')
  }
  return {
    ...metadata,
    storageProvider: 'aws-s3',
    objectKey,
    vaultVersionId: verification.objectVersionId,
    vaultReceiptId: verification.receiptId,
    vaultReceiptKeyId: verification.signingKeyId,
    vaultReceipt: receipt,
    vaultReceiptVerification: verification,
    retentionMode: verification.retentionMode,
    retentionUntil: verification.retainUntil,
    encryptionMode: verification.encryptionMode,
    retentionPolicyReference,
    scanAttestation: attestation,
    scanAttestationId: scanVerification.attestationId,
    scanAttestationKeyId: scanVerification.keyId,
    scanAttestationKeyId: scanVerification.keyId,
    scanResult: {
      status: 'clean',
      scanner: attestationPayload.scanner,
      version: attestationPayload.scannerVersion,
      scannedAt: attestationPayload.scannedAt,
    },
    malwareScanStatus: 'clean',
    vaultReceiptV2Verified: true,
  }
}
