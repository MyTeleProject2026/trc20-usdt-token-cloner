import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAINNET_DIRECT_SPONSOR_APPROVAL_TTL_MS,
  OFFICIAL_MAINNET_USDT_CONTRACT,
  buildMainnetDirectSponsorApprovalMessage,
  mainnetDirectSponsorRequestSnapshotHash,
  resolveMainnetDirectSponsorApprovalPolicy,
  verifyMainnetDirectSponsorApprovalSignature,
} from '../server/mainnet-direct-sponsor-approval.mjs'

const sponsorAddress = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'
const requesterAddress = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
const recipientAddress = 'TTGhREx2pDSxFX555NWz1YwGpiBVPvQA7e'
const organizationReference = 'SPONSOR-ORG-DIRECT-2026'
const agreementReference = 'SPONSOR-AGREEMENT-DIRECT-2026'
const agreementSha256 = 'a'.repeat(64)
const nowMs = Date.parse('2026-11-04T12:00:00.000Z')
const nonce = 'c'.repeat(64)

function env(overrides = {}) {
  return {
    SPONSOR_ASSET_MAINNET_ADDRESS: sponsorAddress,
    SPONSOR_MAINNET_DIRECT_ORGANIZATION_REFERENCE: organizationReference,
    SPONSOR_MAINNET_DIRECT_AGREEMENT_REFERENCE: agreementReference,
    SPONSOR_MAINNET_DIRECT_AGREEMENT_SHA256: agreementSha256,
    SPONSOR_MAINNET_DIRECT_MAX_PAYOUT_USDT_BASE_UNITS: '250000000',
    SPONSOR_APPROVED_AGREEMENT_REFERENCES: [
      [agreementReference, organizationReference, 'mainnet', sponsorAddress, 'asset-grant', 'USDT', OFFICIAL_MAINNET_USDT_CONTRACT].join('|'),
    ].join(';'),
    ...overrides,
  }
}

function request(overrides = {}) {
  return {
    id: '17',
    idempotencyKey: 'mainnet-direct-usdt-request-000017',
    requesterAddress,
    recipientAddress,
    network: 'mainnet',
    asset: 'USDT',
    tokenContract: OFFICIAL_MAINNET_USDT_CONTRACT,
    amountBaseUnits: '12500000',
    decimals: 6,
    status: 'pending-sponsor-review',
    ...overrides,
  }
}

function message(input = {}) {
  const policy = resolveMainnetDirectSponsorApprovalPolicy(env())
  return buildMainnetDirectSponsorApprovalMessage({
    request: request(),
    policy,
    nonce,
    issuedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + MAINNET_DIRECT_SPONSOR_APPROVAL_TTL_MS).toISOString(),
    ...input,
  })
}

test('Mainnet direct sponsor approval policy requires the exact organization, agreement digest, wallet and allowlisted asset scope', () => {
  const policy = resolveMainnetDirectSponsorApprovalPolicy(env())
  assert.equal(policy.configured, true)
  assert.equal(policy.sponsorAddress, sponsorAddress)
  assert.equal(policy.organizationReference, organizationReference)
  assert.equal(policy.agreementReference, agreementReference)
  assert.equal(policy.agreementDocumentSha256, agreementSha256)
  assert.equal(policy.tokenContract, OFFICIAL_MAINNET_USDT_CONTRACT)

  const wrongAddress = resolveMainnetDirectSponsorApprovalPolicy(env({
    SPONSOR_ASSET_MAINNET_ADDRESS: requesterAddress,
  }))
  assert.equal(wrongAddress.configured, false)
  assert.ok(wrongAddress.missing.includes('SPONSOR_APPROVED_AGREEMENT_REFERENCES (exact Mainnet USDT asset-principal scope)'))

  const wrongAgreement = resolveMainnetDirectSponsorApprovalPolicy(env({
    SPONSOR_MAINNET_DIRECT_AGREEMENT_REFERENCE: 'OTHER-AGREEMENT-2026',
  }))
  assert.equal(wrongAgreement.configured, false)

  const wrongContract = resolveMainnetDirectSponsorApprovalPolicy(env({
    SPONSOR_APPROVED_AGREEMENT_REFERENCES: [
      agreementReference, organizationReference, 'mainnet', sponsorAddress, 'asset-grant', 'USDT', requesterAddress,
    ].join('|'),
  }))
  assert.equal(wrongContract.configured, false)
})

test('approval message binds the exact requester, sponsor, recipient, amount, official contract, agreement and nonce', () => {
  const first = message()
  assert.match(first, /Network: TRON Mainnet/)
  assert.match(first, new RegExp('Request idempotency key: ' + request().idempotencyKey))
  assert.match(first, new RegExp('Requester identity wallet: ' + requesterAddress))
  assert.match(first, new RegExp('Asset-principal sponsor wallet: ' + sponsorAddress))
  assert.match(first, new RegExp('Recipient wallet: ' + recipientAddress))
  assert.match(first, new RegExp(OFFICIAL_MAINNET_USDT_CONTRACT))
  assert.match(first, /Amount in base units \(6 decimals\): 12500000/)
  assert.match(first, new RegExp(agreementReference))
  assert.match(first, new RegExp(agreementSha256))
  assert.match(first, new RegExp(nonce))
  assert.match(first, /not a TRON transaction signature/)
  assert.match(first, /does not approve network fees/)
  assert.notEqual(message({ request: request({ amountBaseUnits: '12500001' }) }), first)
  assert.notEqual(message({ request: request({ recipientAddress: requesterAddress }) }).length, first.length)
})

test('request snapshot digest changes for recipient or amount edits', () => {
  const base = mainnetDirectSponsorRequestSnapshotHash(request())
  assert.notEqual(base, mainnetDirectSponsorRequestSnapshotHash(request({ recipientAddress: requesterAddress })))
  assert.notEqual(base, mainnetDirectSponsorRequestSnapshotHash(request({ amountBaseUnits: '12500001' })))
})

test('signature verifier accepts only the configured sponsor signer and valid challenge lifetime', async () => {
  const signedMessage = message()
  const signature = '0x' + 'b'.repeat(130)
  const valid = await verifyMainnetDirectSponsorApprovalSignature({
    message: signedMessage,
    signature,
    expectedSponsorAddress: sponsorAddress,
    nowMs,
    issuedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + MAINNET_DIRECT_SPONSOR_APPROVAL_TTL_MS).toISOString(),
    verifyMessage: async (text, supplied) => {
      assert.equal(text, signedMessage)
      assert.equal(supplied, signature)
      return sponsorAddress
    },
  })
  assert.deepEqual(valid, { verified: true, signerAddress: sponsorAddress })

  const wrongSigner = await verifyMainnetDirectSponsorApprovalSignature({
    message: signedMessage, signature, expectedSponsorAddress: sponsorAddress, nowMs,
    issuedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + MAINNET_DIRECT_SPONSOR_APPROVAL_TTL_MS).toISOString(),
    verifyMessage: async () => requesterAddress,
  })
  assert.deepEqual(wrongSigner, {
    verified: false,
    reason: 'approval-signer-does-not-match-configured-asset-sponsor',
  })

  const expired = await verifyMainnetDirectSponsorApprovalSignature({
    message: signedMessage, signature, expectedSponsorAddress: sponsorAddress, nowMs,
    issuedAt: new Date(nowMs - 20 * 60_000).toISOString(),
    expiresAt: new Date(nowMs - 10 * 60_000).toISOString(),
    verifyMessage: async () => sponsorAddress,
  })
  assert.equal(expired.reason, 'approval-challenge-expired-or-invalid')
})

test('signature recovery errors fail closed and never claim sponsor approval', async () => {
  const result = await verifyMainnetDirectSponsorApprovalSignature({
    message: message(),
    signature: '0x' + 'b'.repeat(130),
    expectedSponsorAddress: sponsorAddress,
    nowMs,
    issuedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + MAINNET_DIRECT_SPONSOR_APPROVAL_TTL_MS).toISOString(),
    verifyMessage: async () => { throw new Error('wallet signature cannot be recovered') },
  })
  assert.deepEqual(result, { verified: false, reason: 'approval-signature-verification-failed' })
})
