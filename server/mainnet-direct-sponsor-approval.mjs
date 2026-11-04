import { createHash } from 'node:crypto'
import { Trx } from 'tronweb'
import { isValidTronAddress } from './tron-address.mjs'

export const MAINNET_DIRECT_SPONSOR_APPROVAL_FORMAT = 'tron-token-studio/mainnet-direct-sponsor-approval/v1'
export const MAINNET_DIRECT_SPONSOR_APPROVAL_TTL_MS = 10 * 60 * 1000
export const OFFICIAL_MAINNET_USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{3,127}$/
const BASE_UNITS_PATTERN = /^[1-9][0-9]{0,77}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const NONCE_PATTERN = /^[0-9a-f]{48,128}$/i
const SIGNATURE_PATTERN = /^0x[0-9a-f]{130}$/i
const MAX_UINT256 = (1n << 256n) - 1n

export function sha256Hex(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function validReference(value) {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value)
}

export function resolveMainnetDirectSponsorApprovalPolicy(env = process.env) {
  const sponsorAddress = typeof env.SPONSOR_ASSET_MAINNET_ADDRESS === 'string'
    ? env.SPONSOR_ASSET_MAINNET_ADDRESS.trim() : ''
  const organizationReference = typeof env.SPONSOR_MAINNET_DIRECT_ORGANIZATION_REFERENCE === 'string'
    ? env.SPONSOR_MAINNET_DIRECT_ORGANIZATION_REFERENCE.trim() : ''
  const agreementReference = typeof env.SPONSOR_MAINNET_DIRECT_AGREEMENT_REFERENCE === 'string'
    ? env.SPONSOR_MAINNET_DIRECT_AGREEMENT_REFERENCE.trim() : ''
  const agreementDocumentSha256 = typeof env.SPONSOR_MAINNET_DIRECT_AGREEMENT_SHA256 === 'string'
    ? env.SPONSOR_MAINNET_DIRECT_AGREEMENT_SHA256.trim() : ''
  const maxUsdtBaseUnits = typeof env.SPONSOR_MAINNET_DIRECT_MAX_PAYOUT_USDT_BASE_UNITS === 'string'
    ? env.SPONSOR_MAINNET_DIRECT_MAX_PAYOUT_USDT_BASE_UNITS.trim() : ''

  const missing = []
  if (!isValidTronAddress(sponsorAddress)) missing.push('SPONSOR_ASSET_MAINNET_ADDRESS')
  if (!validReference(organizationReference)) missing.push('SPONSOR_MAINNET_DIRECT_ORGANIZATION_REFERENCE')
  if (!validReference(agreementReference)) missing.push('SPONSOR_MAINNET_DIRECT_AGREEMENT_REFERENCE')
  if (!SHA256_PATTERN.test(agreementDocumentSha256)) missing.push('SPONSOR_MAINNET_DIRECT_AGREEMENT_SHA256')
  if (!BASE_UNITS_PATTERN.test(maxUsdtBaseUnits) || BigIntSafe(maxUsdtBaseUnits) === null) {
    missing.push('SPONSOR_MAINNET_DIRECT_MAX_PAYOUT_USDT_BASE_UNITS')
  }

  const scopes = String(env.SPONSOR_APPROVED_AGREEMENT_REFERENCES || '')
    .split(';').map((value) => value.trim()).filter(Boolean)
  const exactScopeApproved = scopes.some((scope) => {
    const fields = scope.split('|')
    return fields.length === 7
      && fields[0] === agreementReference
      && fields[1] === organizationReference
      && fields[2] === 'mainnet'
      && fields[3] === sponsorAddress
      && fields[4] === 'asset-grant'
      && fields[5] === 'USDT'
      && fields[6] === OFFICIAL_MAINNET_USDT_CONTRACT
  })
  if (!exactScopeApproved) missing.push('SPONSOR_APPROVED_AGREEMENT_REFERENCES (exact Mainnet USDT asset-principal scope)')

  return {
    configured: missing.length === 0,
    missing,
    ...(missing.length === 0 ? {
      sponsorAddress,
      organizationReference,
      agreementReference,
      agreementDocumentSha256,
      maxUsdtBaseUnits,
      network: 'mainnet',
      asset: 'USDT',
      tokenContract: OFFICIAL_MAINNET_USDT_CONTRACT,
      purpose: 'asset-grant',
    } : {}),
  }
}

function BigIntSafe(value) {
  try {
    const parsed = BigInt(value)
    return parsed > 0n && parsed <= MAX_UINT256 ? parsed : null
  } catch {
    return null
  }
}

export function mainnetDirectSponsorRequestSnapshotHash(request) {
  const fields = [
    String(request?.id ?? ''),
    String(request?.idempotencyKey ?? ''),
    String(request?.requesterAddress ?? ''),
    String(request?.recipientAddress ?? ''),
    String(request?.network ?? ''),
    String(request?.asset ?? ''),
    String(request?.tokenContract ?? ''),
    String(request?.amountBaseUnits ?? ''),
    String(request?.decimals ?? ''),
    String(request?.status ?? ''),
  ]
  return sha256Hex(fields.join('\n'))
}

export function buildMainnetDirectSponsorApprovalMessage({
  request,
  policy,
  nonce,
  issuedAt,
  expiresAt,
} = {}) {
  if (!request || request.network !== 'mainnet' || request.asset !== 'USDT'
    || request.tokenContract !== OFFICIAL_MAINNET_USDT_CONTRACT
    || !isValidTronAddress(request.requesterAddress)
    || !isValidTronAddress(request.recipientAddress)
    || request.recipientAddress === request.requesterAddress
    || !BASE_UNITS_PATTERN.test(String(request.amountBaseUnits))
    || Number(request.decimals) !== 6
    || !policy?.configured || !isValidTronAddress(policy.sponsorAddress)
    || typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) {
    throw new TypeError('mainnet-direct-sponsor-approval-input-invalid')
  }
  const amount = BigIntSafe(String(request.amountBaseUnits))
  const cap = BigIntSafe(String(policy.maxUsdtBaseUnits))
  if (amount === null || cap === null || amount > cap) {
    throw new TypeError('mainnet-direct-sponsor-approval-amount-outside-policy')
  }
  const issuedAtMs = Date.parse(issuedAt)
  const expiresAtMs = Date.parse(expiresAt)
  if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs)
    || new Date(issuedAtMs).toISOString() !== issuedAt
    || new Date(expiresAtMs).toISOString() !== expiresAt
    || expiresAtMs <= issuedAtMs
    || expiresAtMs - issuedAtMs > MAINNET_DIRECT_SPONSOR_APPROVAL_TTL_MS) {
    throw new TypeError('mainnet-direct-sponsor-approval-expiry-invalid')
  }

  return [
    'TRON Token Studio direct sponsor payout approval',
    'Format: ' + MAINNET_DIRECT_SPONSOR_APPROVAL_FORMAT,
    'Purpose: approve one exact Mainnet USDT principal payout to the named recipient.',
    'Network: TRON Mainnet',
    'Request ID: ' + String(request.id),
    'Request idempotency key: ' + request.idempotencyKey,
    'Requester identity wallet: ' + request.requesterAddress,
    'Sponsor organization reference: ' + policy.organizationReference,
    'Asset-principal sponsor wallet: ' + policy.sponsorAddress,
    'Recipient wallet: ' + request.recipientAddress,
    'Asset: Tether USDT (TRC-20)',
    'Official USDT contract: ' + OFFICIAL_MAINNET_USDT_CONTRACT,
    'Amount in base units (6 decimals): ' + String(request.amountBaseUnits),
    'Separate executed agreement reference: ' + policy.agreementReference,
    'SHA-256 of exact executed agreement file: ' + policy.agreementDocumentSha256,
    'Per-request sponsor principal cap in base units: ' + policy.maxUsdtBaseUnits,
    'Challenge nonce: ' + nonce,
    'Issued at: ' + issuedAt,
    'Expires at: ' + expiresAt,
    'This is a request-specific sponsor approval signature, not a TRON transaction signature.',
    'It does not approve network fees, reserve funds, sign a transfer, authorize provider execution, or guarantee an exchange deposit credit.',
    'It cannot be reused for another recipient, amount, contract, network, request, or sponsor organization.',
  ].join('\n')
}

export async function verifyMainnetDirectSponsorApprovalSignature({
  message,
  signature,
  expectedSponsorAddress,
  nowMs = Date.now(),
  issuedAt,
  expiresAt,
  verifyMessage = (text, sig) => Trx.verifyMessageV2(text, sig),
} = {}) {
  if (typeof message !== 'string' || message.length < 100 || message.length > 4096
    || !isValidTronAddress(expectedSponsorAddress)
    || typeof signature !== 'string' || !SIGNATURE_PATTERN.test(signature)) {
    return { verified: false, reason: 'approval-signature-input-invalid' }
  }
  const issuedAtMs = Date.parse(issuedAt)
  const expiresAtMs = Date.parse(expiresAt)
  if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs)
    || issuedAtMs > nowMs + 5_000 || expiresAtMs <= nowMs
    || expiresAtMs <= issuedAtMs
    || expiresAtMs - issuedAtMs > MAINNET_DIRECT_SPONSOR_APPROVAL_TTL_MS) {
    return { verified: false, reason: 'approval-challenge-expired-or-invalid' }
  }

  let recoveredAddress
  try {
    recoveredAddress = await verifyMessage(message, signature)
  } catch {
    return { verified: false, reason: 'approval-signature-verification-failed' }
  }
  if (recoveredAddress !== expectedSponsorAddress) {
    return { verified: false, reason: 'approval-signer-does-not-match-configured-asset-sponsor' }
  }
  return { verified: true, signerAddress: recoveredAddress }
}
