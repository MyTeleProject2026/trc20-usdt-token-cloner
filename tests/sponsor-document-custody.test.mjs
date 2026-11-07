import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import net from 'node:net'
import {
  getDocumentCustodyConfig, scanAndStoreEvidence, scanWithClamAv, validateEvidenceBytes,
} from '../server/sponsor-document-custody.mjs'

const pdf = Buffer.from('%PDF-1.7\ntrusted test document\n%%EOF')
const appId = '123e4567-e89b-42d3-a456-426614174000'
const mandateId = '123e4567-e89b-42d3-a456-426614174001'
const config = {
  vaultBase:'https://vault.example.test',
  vaultToken:'v'.repeat(40),
  receiptSecret:'r'.repeat(40),
  scannerHost:'clamav.internal',
  scannerPort:3310,
  scannerVersion:'ClamAV 1.4.2',
  scannerTimeoutMs:5000,
}

function signedVaultFetch(calls = []) {
  return async (url, options) => {
    calls.push({url,options})
    const objectKey = new URL(url).pathname.split('/').slice(3).map(decodeURIComponent).join('/')
    const fields = {
      stored:true, objectKey,
      contentSha256:options.headers['X-Content-SHA256'],
      byteSize:Number(options.headers['Content-Length']),
      encryptedAtRest:true,
      retentionPolicyReference:options.headers['X-Retention-Policy-Reference'],
      versionId:'vault-version-001',
    }
    const receiptSignature = createHmac('sha256', config.receiptSecret).update(JSON.stringify(fields)).digest('hex')
    return new Response(JSON.stringify({...fields,receiptSignature}), {status:201,headers:{'content-type':'application/json'}})
  }
}

test('document custody config fails closed until vault, receipt key and scanner are configured', () => {
  assert.equal(getDocumentCustodyConfig({}).ready, false)
  assert.equal(getDocumentCustodyConfig({
    SPONSOR_ORG_VAULT_API_BASE:'https://vault.example.test',
    SPONSOR_ORG_VAULT_ALLOWED_HOSTS:'vault.example.test',
    SPONSOR_ORG_VAULT_API_TOKEN:'v'.repeat(40),
    SPONSOR_ORG_CLAMAV_HOST:'clamav.internal',
    SPONSOR_ORG_CLAMAV_ALLOWED_HOSTS:'clamav.internal',
    SPONSOR_ORG_CLAMAV_VERSION:'ClamAV 1.4.2',
  }).ready, false)
  const ready = getDocumentCustodyConfig({
    SPONSOR_ORG_VAULT_API_BASE:'https://vault.example.test',
    SPONSOR_ORG_VAULT_ALLOWED_HOSTS:'vault.example.test',
    SPONSOR_ORG_VAULT_API_TOKEN:'v'.repeat(40),
    SPONSOR_ORG_VAULT_RECEIPT_HMAC_SECRET:'r'.repeat(40),
    SPONSOR_ORG_CLAMAV_HOST:'clamav.internal',
    SPONSOR_ORG_CLAMAV_VERSION:'ClamAV 1.4.2',
  })
  assert.equal(ready.ready, true)
})

test('evidence content must match allowed MIME signatures and byte bounds', () => {
  const metadata = validateEvidenceBytes(pdf,'application/pdf')
  assert.equal(metadata.byteSize,pdf.length)
  assert.equal(metadata.contentSha256.length,64)
  assert.throws(()=>validateEvidenceBytes(Buffer.from('not a pdf document'),'application/pdf'),/evidence-content-type-mismatch/)
  assert.throws(()=>validateEvidenceBytes(pdf,'text/plain'),/evidence-media-type-not-allowed/)
})

test('clean evidence is scanned before private vault upload and receipt verification', async () => {
  const calls = []
  const result = await scanAndStoreEvidence({
    buffer:pdf,mediaType:'application/pdf',retentionPolicyReference:'retention-policy-v1',
    applicationId:appId,mandateId,config,
    scan:async()=>({status:'clean',scanner:'clamav-instream',version:'ClamAV 1.4.2/clean-db'}),
    fetchImpl:signedVaultFetch(calls),
  })
  assert.equal(calls.length,1)
  assert.equal(calls[0].options.method,'PUT')
  assert.equal(calls[0].options.headers['X-Encryption-Required'],'true')
  assert.equal(result.malwareScanStatus,'clean')
  assert.equal(result.vaultReceiptVerified,true)
  assert.equal(result.vaultVersionId,'vault-version-001')
})

test('infected or indeterminate evidence is never forwarded to the vault', async () => {
  let calls = 0
  await assert.rejects(scanAndStoreEvidence({
    buffer:pdf,mediaType:'application/pdf',retentionPolicyReference:'retention-policy-v1',
    applicationId:appId,mandateId,config,
    scan:async()=>{throw new Error('malware-detected')},
    fetchImpl:async()=>{calls++;throw new Error('must-not-run')},
  }),/malware-detected/)
  assert.equal(calls,0)
})

test('unsigned or mismatched vault receipts fail closed', async () => {
  await assert.rejects(scanAndStoreEvidence({
    buffer:pdf,mediaType:'application/pdf',retentionPolicyReference:'retention-policy-v1',
    applicationId:appId,mandateId,config,
    scan:async()=>({status:'clean',scanner:'clamav-instream',version:'ClamAV 1.4.2'}),
    fetchImpl:async()=>new Response(JSON.stringify({stored:true,objectKey:'wrong',contentSha256:'0'.repeat(64),
      byteSize:pdf.length,encryptedAtRest:true,retentionPolicyReference:'retention-policy-v1',
      versionId:'v1',receiptSignature:'0'.repeat(64)}),{status:201}),
  }),/private-vault-receipt-mismatch/)
})

test('ClamAV handshake verifies the configured daemon version before scanning bytes', async () => {
  const server = net.createServer((socket) => {
    socket.once('data', (data) => {
      const command = data.subarray(0, 10).toString('utf8')
      if (command.startsWith('zVERSION')) socket.end('ClamAV 1.4.2/123/test-db\\n')
      else if (command.startsWith('zINSTREAM')) socket.end('stream: OK\\n')
      else socket.end('UNKNOWN COMMAND\\n')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  try {
    const result = await scanWithClamAv(pdf, {...config,scannerHost:'127.0.0.1',scannerPort:address.port})
    assert.equal(result.status,'clean')
    assert.equal(result.scanner,'clamav-instream')
    assert.match(result.version,/^ClamAV 1\\.4\\.2/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('ClamAV version mismatch fails closed before file scanning', async () => {
  const server = net.createServer((socket) => socket.once('data', () => socket.end('ClamAV 1.3.0/123/test-db\\n')))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  try {
    await assert.rejects(scanWithClamAv(pdf,{...config,scannerHost:'127.0.0.1',scannerPort:address.port}),/malware-scanner-version-mismatch/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
