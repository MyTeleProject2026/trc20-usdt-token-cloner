import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import {
  getDocumentCustodyV2Config, scanAndStoreEvidenceV2,
} from '../server/sponsor-document-custody-v2.mjs'
import { buildSponsorVaultTrustRegistryPins } from '../server/sponsor-vault-trust-registry.mjs'

const now = Date.now()
const pdf = Buffer.from('%PDF-1.7\nprivate evidence fixture\n%%EOF')
const organizationId = '123e4567-e89b-42d3-a456-426614174000'
const mandateId = '123e4567-e89b-42d3-a456-426614174001'
const scanner = generateKeyPairSync('ed25519')
const vault = generateKeyPairSync('ed25519')
const pem = (pair) => pair.publicKey.export({type:'spki',format:'pem'})

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key)+':'+canonical(value[key])).join(',') + '}'
}
function signed(payload, pair, keyId) {
  return {...payload,signature:{algorithm:'Ed25519',keyId,value:sign(null,Buffer.from(canonical(payload)),pair.privateKey).toString('base64url')}}
}
const registryJson = JSON.stringify({
  'vault-key-v1':{active:true,publicKeyPem:pem(vault)},
})
const scannerRegistryJson = JSON.stringify({
  'scanner-key-v1':{active:true,publicKeyPem:pem(scanner)},
})
const env = {
  SPONSOR_ORG_SCANNER_ATTESTATION_API_BASE:'https://scanner.example.test',
  SPONSOR_ORG_SCANNER_ATTESTATION_ALLOWED_HOSTS:'scanner.example.test',
  SPONSOR_ORG_SCANNER_ATTESTATION_API_TOKEN:'s'.repeat(48),
  SPONSOR_ORG_SCANNER_NAME:'ClamAV',
  SPONSOR_ORG_SCANNER_VERSION_PREFIX:'1.4.2',
  SPONSOR_ORG_VAULT_API_BASE:'https://vault.example.test',
  SPONSOR_ORG_VAULT_ALLOWED_HOSTS:'vault.example.test',
  SPONSOR_ORG_VAULT_API_TOKEN:'v'.repeat(48),
  SPONSOR_ORG_VAULT_RECEIPT_ISSUER:'approved-vault-gateway',
  SPONSOR_ORG_VAULT_MIN_RETENTION_DAYS:'365',
  SPONSOR_ORG_VAULT_RECEIPT_PUBLIC_KEYS:registryJson,
  SPONSOR_ORG_VAULT_RECEIPT_KEYS_VERSION:'vault-keys-v1',
  SPONSOR_ORG_SCANNER_ATTESTATION_PUBLIC_KEYS:scannerRegistryJson,
  SPONSOR_ORG_SCANNER_ATTESTATION_KEYS_VERSION:'scanner-keys-v1',
}
const pins = buildSponsorVaultTrustRegistryPins(env)
env.SPONSOR_ORG_VAULT_RECEIPT_KEYS_SHA256 = pins.vaultReceiptKeysSha256
env.SPONSOR_ORG_SCANNER_ATTESTATION_KEYS_SHA256 = pins.scannerAttestationKeysSha256
const config = getDocumentCustodyV2Config(env)
const digest = (await import('node:crypto')).createHash('sha256').update(pdf).digest('hex')

function makeAttestation({result='CLEAN',contentSha256=digest,scannedAt=new Date(now-1000).toISOString()}={}) {
  return signed({
    schema:'tron-transfer.malware-scan-attestation.v1',
    attestationId:'scan-attestation-001',
    contentSha256,
    byteSize:pdf.length,
    result,
    completed:true,
    scanner:'ClamAV',
    scannerVersion:'1.4.2-123-test-signatures',
    scannedAt,
  },scanner,'scanner-key-v1')
}
function gatewayFetch({tamperReceipt=false,scanAttestationOverride=null}={}) {
  const calls=[]
  const fetchImpl=async (url,options)=>{
    calls.push({url,options})
    if(String(url).endsWith('/v1/scans')) {
      return new Response(JSON.stringify({attestation:scanAttestationOverride || makeAttestation()}),{status:200,headers:{'content-type':'application/json'}})
    }
    const prefix='/v2/objects/'
    const pathname=new URL(url).pathname
    const objectKey=pathname.slice(prefix.length).split('/').map(decodeURIComponent).join('/')
    const attestation=JSON.parse(Buffer.from(options.headers['X-Scan-Attestation'],'base64url').toString('utf8'))
    const issuedAt=new Date(now).toISOString()
    const retentionUntil=new Date(now+366*24*60*60*1000).toISOString()
    const receipt=signed({
      schema:'tron-transfer.private-vault-receipt.v2',
      issuer:'approved-vault-gateway',
      audience:'tron-transfer-onboarding',
      receiptId:'vault-receipt-001',
      organizationId,
      issuedAt,
      object:{objectKey,versionId:'s3-version-001',sha256:digest,byteSize:pdf.length,mediaType:'application/pdf'},
      storage:{
        provider:'aws-s3',
        encryption:{verified:true,mode:'SSE-KMS',keyReference:'kms-key-alias/tron-evidence'},
        retention:{verified:true,mode:'GOVERNANCE',policyReference:'approved-policy-001',retainUntil:retentionUntil,legalHold:false},
      },
      malwareScan:{
        verified:true,result:'CLEAN',scanner:'ClamAV',scannerVersion:'1.4.2-123-test-signatures',
        attestation:tamperReceipt?{...attestation,contentSha256:'b'.repeat(64)}:attestation,
      },
    },vault,'vault-key-v1')
    return new Response(JSON.stringify({receipt}),{status:201,headers:{'content-type':'application/json'}})
  }
  return {calls,fetchImpl}
}
const args={buffer:pdf,mediaType:'application/pdf',retentionPolicyReference:'approved-policy-001',
  applicationId:organizationId,mandateId,config,now:()=>now}

test('V2 custody configuration requires separate pinned scanner and vault trust registries',()=>{
  assert.equal(config.ready,true)
  assert.equal(getDocumentCustodyV2Config({}).ready,false)
  const tampered={...env,SPONSOR_ORG_VAULT_RECEIPT_PUBLIC_KEYS:JSON.stringify({})}
  assert.equal(getDocumentCustodyV2Config(tampered).ready,false)
})

test('custody config rejects shared signing keys between vault receipts and scanner attestations',()=>{
  const shared={...env,SPONSOR_ORG_SCANNER_ATTESTATION_PUBLIC_KEYS:registryJson}
  const sharedPins=buildSponsorVaultTrustRegistryPins(shared)
  shared.SPONSOR_ORG_VAULT_RECEIPT_KEYS_SHA256=sharedPins.vaultReceiptKeysSha256
  shared.SPONSOR_ORG_SCANNER_ATTESTATION_KEYS_SHA256=sharedPins.scannerAttestationKeysSha256
  const result=getDocumentCustodyV2Config(shared)
  assert.equal(result.ready,false)
  assert.ok(result.missing.includes('vault-and-scanner-signing-keys-must-be-independent'))
})

test('scanner attestation is obtained and verified before the V2 vault upload',async()=>{
  const {calls,fetchImpl}=gatewayFetch()
  const result=await scanAndStoreEvidenceV2({...args,fetchImpl})
  assert.equal(calls.length,2)
  assert.match(calls[0].url,/scanner\.example\.test\/v1\/scans$/)
  assert.match(calls[1].url,/vault\.example\.test\/v2\/objects\//)
  assert.equal(calls[1].options.headers['X-Scan-Attestation'] !== undefined,true)
  assert.equal(result.vaultReceiptV2Verified,true)
  assert.equal(result.vaultVersionId,'s3-version-001')
  assert.equal(result.vaultReceiptKeyId,'vault-key-v1')
  assert.equal(result.scanAttestationKeyId,'scanner-key-v1')
  assert.equal(result.malwareScanStatus,'clean')
})

test('infected, stale or mismatched scanner attestations stop before vault storage',async()=>{
  const infected=gatewayFetch({scanAttestationOverride:makeAttestation({result:'INFECTED'})})
  await assert.rejects(scanAndStoreEvidenceV2({...args,fetchImpl:infected.fetchImpl}),/independent-scan-attestation-invalid/)
  assert.equal(infected.calls.length,1)
  const stale=gatewayFetch({scanAttestationOverride:makeAttestation({scannedAt:new Date(now-3600000).toISOString()})})
  await assert.rejects(scanAndStoreEvidenceV2({...args,fetchImpl:stale.fetchImpl}),/independent-scan-attestation-invalid/)
  assert.equal(stale.calls.length,1)
})

test('vault receipt must be signed by a pinned key and bind the exact scan attestation',async()=>{
  const altered=gatewayFetch({tamperReceipt:true})
  await assert.rejects(scanAndStoreEvidenceV2({...args,fetchImpl:altered.fetchImpl}),/private-vault-receipt-v2-invalid/)
  assert.equal(altered.calls.length,2)
  const wrongSignature=gatewayFetch()
  wrongSignature.fetchImpl=async (url,options)=>{
    const result=await gatewayFetch().fetchImpl(url,options)
    if(String(url).includes('/v2/objects/')){
      const body=await result.json()
      body.receipt.signature.value='A'.repeat(86)
      return new Response(JSON.stringify(body),{status:201})
    }
    return result
  }
  await assert.rejects(scanAndStoreEvidenceV2({...args,fetchImpl:wrongSignature.fetchImpl}),/private-vault-receipt-v2-invalid/)
})

test('scanner service failures and invalid content fail closed',async()=>{
  let calls=0
  await assert.rejects(scanAndStoreEvidenceV2({...args,fetchImpl:async()=>{calls++;throw new Error('offline')}}),/independent-scanner-service-unavailable/)
  assert.equal(calls,1)
  await assert.rejects(scanAndStoreEvidenceV2({...args,buffer:Buffer.from('not pdf'),fetchImpl:async()=>{calls++;}}),/evidence-content-type-mismatch/)
})
