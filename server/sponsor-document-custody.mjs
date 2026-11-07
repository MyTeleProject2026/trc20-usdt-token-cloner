import { createHash, randomUUID } from 'node:crypto'
import net from 'node:net'

const MAX_BYTES = 20 * 1024 * 1024
const ALLOWED_MEDIA = new Set(['application/pdf', 'image/jpeg', 'image/png'])

function clean(value, max = 512) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

export function validateEvidenceBytes(buffer, mediaType) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || buffer.length > MAX_BYTES) {
    throw new Error('evidence-size-out-of-range')
  }
  if (!ALLOWED_MEDIA.has(mediaType)) throw new Error('evidence-media-type-not-allowed')
  const valid = mediaType === 'application/pdf'
    ? buffer.subarray(0, 5).toString('ascii') === '%PDF-'
    : mediaType === 'image/jpeg'
      ? buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
      : buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
  if (!valid) throw new Error('evidence-content-type-mismatch')
  return { byteSize: buffer.length, contentSha256: sha256(buffer), mediaType }
}

export function getDocumentCustodyConfig(env = process.env) {
  let vaultUrl
  try { vaultUrl = new URL(clean(env.SPONSOR_ORG_VAULT_API_BASE, 512)) } catch { return { ready: false, reason: 'vault-endpoint-not-configured' } }
  const allowedHosts = clean(env.SPONSOR_ORG_VAULT_ALLOWED_HOSTS, 2048).split(',').map((v) => v.trim().toLowerCase()).filter(Boolean)
  const host = vaultUrl.hostname.toLowerCase()
  const validVault = vaultUrl.protocol === 'https:' && !vaultUrl.username && !vaultUrl.password
    && !vaultUrl.search && !vaultUrl.hash && allowedHosts.includes(host)
    && !/^(localhost|127\.|0\.|169\.254\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(host)
  const token = clean(env.SPONSOR_ORG_VAULT_API_TOKEN, 4096)
  const scannerHost = clean(env.SPONSOR_ORG_CLAMAV_HOST, 255)
  const scannerPort = Number(env.SPONSOR_ORG_CLAMAV_PORT || 3310)
  const scannerVersion = clean(env.SPONSOR_ORG_CLAMAV_VERSION, 80)
  const scannerTimeoutMs = Number(env.SPONSOR_ORG_CLAMAV_TIMEOUT_MS || 15000)
  if (!validVault || token.length < 32) return { ready: false, reason: 'private-vault-configuration-invalid' }
  if (!scannerHost || !Number.isInteger(scannerPort) || scannerPort < 1 || scannerPort > 65535
    || !scannerVersion || !Number.isInteger(scannerTimeoutMs) || scannerTimeoutMs < 1000 || scannerTimeoutMs > 60000) {
    return { ready: false, reason: 'independent-malware-scanner-not-configured' }
  }
  return {
    ready: true,
    vaultBase: vaultUrl.origin + vaultUrl.pathname.replace(/\/$/, ''),
    vaultToken: token,
    vaultHost: host,
    scannerHost,
    scannerPort,
    scannerVersion,
    scannerTimeoutMs,
  }
}

function clamavFrame(buffer) {
  const chunkSize = 64 * 1024
  const chunks = [Buffer.from('zINSTREAM\0')]
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    const chunk = buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length))
    const size = Buffer.alloc(4)
    size.writeUInt32BE(chunk.length, 0)
    chunks.push(size, chunk)
  }
  chunks.push(Buffer.alloc(4))
  return Buffer.concat(chunks)
}

export function scanWithClamAv(buffer, config) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: config.scannerHost, port: config.scannerPort })
    const chunks = []
    let settled = false
    const finish = (error, result) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(error)
      else resolve(result)
    }
    socket.setTimeout(config.scannerTimeoutMs)
    socket.once('connect', () => socket.end(clamavFrame(buffer)))
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.once('timeout', () => finish(new Error('malware-scanner-timeout')))
    socket.once('error', () => finish(new Error('malware-scanner-unavailable')))
    socket.once('end', () => {
      const reply = Buffer.concat(chunks).toString('utf8').trim()
      if (/\bOK$/.test(reply)) return finish(null, { status: 'clean', scanner: 'clamav-instream', version: config.scannerVersion })
      if (/\bFOUND$/.test(reply)) return finish(new Error('malware-detected'))
      return finish(new Error('malware-scan-indeterminate'))
    })
  })
}

export async function storeInPrivateVault({ buffer, mediaType, retentionPolicyReference, applicationId, mandateId, config, fetchImpl = fetch }) {
  const metadata = validateEvidenceBytes(buffer, mediaType)
  const objectKey = `sponsor-evidence/${applicationId}/${mandateId}/${randomUUID()}`
  const endpoint = config.vaultBase + '/v1/objects/' + objectKey.split('/').map(encodeURIComponent).join('/')
  let response
  try {
    response = await fetchImpl(endpoint, {
      method: 'PUT',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: 'Bearer ' + config.vaultToken,
        'Content-Type': mediaType,
        'Content-Length': String(buffer.length),
        'X-Content-SHA256': metadata.contentSha256,
        'X-Encryption-Required': 'true',
        'X-Retention-Policy-Reference': retentionPolicyReference,
        'X-Malware-Scan-Status': 'clean',
        'X-Malware-Scanner': 'clamav-instream',
      },
      body: buffer,
    })
  } catch {
    throw new Error('private-vault-upload-unavailable')
  }
  if (!response.ok) throw new Error('private-vault-upload-rejected')
  let receipt
  try { receipt = await response.json() } catch { throw new Error('private-vault-receipt-invalid') }
  if (receipt?.stored !== true || receipt.objectKey !== objectKey
    || String(receipt.contentSha256 || '').toLowerCase() !== metadata.contentSha256
    || Number(receipt.byteSize) !== metadata.byteSize || receipt.encryptedAtRest !== true
    || receipt.retentionPolicyReference !== retentionPolicyReference
    || typeof receipt.versionId !== 'string' || !receipt.versionId.trim()) {
    throw new Error('private-vault-receipt-mismatch')
  }
  return {
    ...metadata,
    storageProvider: 'approved-private-document-vault',
    objectKey,
    encryptedAtRest: true,
    retentionPolicyReference,
    vaultVersionId: receipt.versionId,
    vaultReceiptVerified: true,
  }
}

export async function scanAndStoreEvidence({ buffer, mediaType, retentionPolicyReference, applicationId, mandateId, config, scan = scanWithClamAv, fetchImpl = fetch }) {
  const metadata = validateEvidenceBytes(buffer, mediaType)
  const scanResult = await scan(buffer, config)
  if (scanResult?.status !== 'clean' || scanResult?.scanner !== 'clamav-instream') throw new Error('malware-scan-not-clean')
  const vault = await storeInPrivateVault({ buffer, mediaType, retentionPolicyReference, applicationId, mandateId, config, fetchImpl })
  return { ...vault, scanResult, malwareScanStatus: 'clean' }
}
