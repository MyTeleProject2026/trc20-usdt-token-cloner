import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { verifyMalwareScanAttestation, verifyPrivateVaultReceiptV2 } from '../server/sponsor-vault-receipt-v2.mjs'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const registry = { 'test-key-01': { active: true, publicKeyPem: publicKey.export({type:'spki',format:'pem'}) } }
const now = Date.now()
const digest = 'a'.repeat(64)
const organizationId = 'org-test-01'
function signed(payload) {
  const canonical = (v) => v === null || typeof v !== 'object' ? JSON.stringify(v)
    : Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']'
      : '{' + Object.keys(v).sort().map(k => JSON.stringify(k)+':'+canonical(v[k])).join(',') + '}'
  const signature = sign(null, Buffer.from(canonical(payload)), privateKey).toString('base64url')
  return { ...payload, signature: { algorithm:'Ed25519', keyId:'test-key-01', value:signature } }
}
function attestation() {
  return signed({schema:'tron-transfer.malware-scan-attestation.v1',attestationId:'scan-01',
    contentSha256:digest,byteSize:123,result:'CLEAN',completed:true,scanner:'isolated-scan-adapter',
    scannerVersion:'1.0.0',scannedAt:new Date(now-1000).toISOString()})
}
function receipt() {
  return signed({schema:'tron-transfer.private-vault-receipt.v2',issuer:'vault-gateway',audience:'tron-transfer-onboarding',
    receiptId:'receipt-01',organizationId,object:{objectKey:'org/org-test-01/doc-01',versionId:'version-01',
      sha256:digest,byteSize:123,mediaType:'application/pdf'},
    storage:{provider:'aws-s3',encryption:{verified:true,mode:'SSE-KMS',keyReference:'kms-key-alias'},
      retention:{verified:true,mode:'GOVERNANCE',policyReference:'policy-01',retainUntil:new Date(now+86400000).toISOString()}},
    malwareScan:{verified:true,result:'CLEAN',attestation:attestation()}})
}
const expected = {keyRegistry:registry,scannerKeyRegistry:registry,expectedObjectKey:'org/org-test-01/doc-01',expectedSha256:digest,
  expectedByteSize:123,expectedMediaType:'application/pdf',expectedOrganizationId:organizationId,nowMs:now}

test('accepts correctly signed and bound v2 receipt with fresh independent scan attestation',()=>{
  const result=verifyPrivateVaultReceiptV2(receipt(),expected)
  assert.equal(result.valid,true)
  assert.equal(result.payoutAuthorized,false)
})
test('rejects altered receipt after signing',()=>{
  const value=receipt(); value.object.versionId='changed'
  assert.equal(verifyPrivateVaultReceiptV2(value,expected).reason,'signature-verification-failed')
})
test('rejects wrong organization and object binding',()=>{
  assert.equal(verifyPrivateVaultReceiptV2(receipt(),{...expected,expectedOrganizationId:'other'}).reason,'vault-receipt-organization-mismatch')
  assert.equal(verifyPrivateVaultReceiptV2(receipt(),{...expected,expectedObjectKey:'other'}).reason,'vault-receipt-object-binding-mismatch')
})
test('rejects retention or encryption claims that are not independently verified',()=>{
  const noRetention=receipt(); noRetention.storage.retention.verified=false
  // Re-sign to isolate the retention validation branch.
  const payload={...noRetention}; delete payload.signature
  assert.equal(verifyPrivateVaultReceiptV2(signed(payload),expected).reason,'vault-receipt-retention-not-verified')
  const noEncryption=receipt(); noEncryption.storage.encryption.verified=false
  const p={...noEncryption}; delete p.signature
  assert.equal(verifyPrivateVaultReceiptV2(signed(p),expected).reason,'vault-receipt-encryption-not-verified')
})
test('rejects stale or mismatched scanner attestations',()=>{
  const old=receipt(); old.malwareScan.attestation.scannedAt=new Date(now-3600000).toISOString()
  const p={...old}; delete p.signature
  assert.equal(verifyPrivateVaultReceiptV2(signed(p),expected).reason,'vault-receipt-malware-attestation-invalid')
  const wrong=receipt(); wrong.malwareScan.attestation.contentSha256='b'.repeat(64)
  const q={...wrong}; delete q.signature
  assert.equal(verifyPrivateVaultReceiptV2(signed(q),expected).reason,'vault-receipt-malware-attestation-invalid')
})
test('rejects unknown or inactive signing keys',()=>{
  assert.equal(verifyPrivateVaultReceiptV2(receipt(),{...expected,keyRegistry:{}}).reason,'signing-key-not-trusted')
  assert.equal(verifyMalwareScanAttestation(attestation(),{keyRegistry:{'test-key-01':{...registry['test-key-01'],active:false}},expectedSha256:digest,expectedByteSize:123,nowMs:now}).reason,'signing-key-not-trusted')
})
