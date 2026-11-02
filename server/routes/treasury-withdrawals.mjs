import { createHash, randomUUID } from 'node:crypto'
import { Router } from 'express'
import pg from 'pg'
import { TronWeb } from 'tronweb'
import { isValidTronAddress } from '../tron-address.mjs'
import {
  createFireblocksClient,
  fireblocksConfiguration,
  extractFireblocksAddresses,
  providerAssetAvailableBaseUnits,
  fireblocksAssetIdentifierMatches,
  isOfficialFireblocksUsdtAsset,
  classifyFireblocksTransaction,
  isNativeFireblocksTrxAsset,
  maxFireblocksEstimatedFeeSun,
} from '../fireblocks-client.mjs'
import { getFireblocksOutboundHistoryStatus } from './fireblocks-outbound-history.mjs'
import { getWalletAuthSession, normalizeDatabaseConnectionString, databaseSslConfig, isApprovedSponsorAgreementScope } from '../database.mjs'
import {
  buildTreasuryWithdrawalAuthorizationMessage,
  buildTreasuryTrxWithdrawalAuthorizationMessage,
  isTreasuryAuthorizationExpiryValid,
} from '../../src/treasury-withdrawal-auth.mjs'

const { Pool } = pg
const MAINNET_RPC = 'https://api.trongrid.io'
// Both real-value submission paths remain hard-locked until a separate reviewed
// release change after sponsor, custody, security and funded acceptance gates.
const REAL_VALUE_PAYOUT_EXECUTION_DISABLED = true
// Native TRX principal withdrawals are not part of the USDT sponsor-release path.
const REAL_VALUE_TRX_PAYOUT_EXECUTION_DISABLED = true
const REAL_VALUE_RELEASE_MAX_FUTURE_MS = 30 * 24 * 60 * 60 * 1000
const USDT_MAINNET = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const TXID_PATTERN = /^[0-9a-f]{64}$/i
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{24,128}$/
const SESSION_PATTERN = /^[A-Za-z0-9_-]{43}$/
const OWNER_PAYOUT_SIGNATURE_PATTERN = /^0x[0-9a-f]{130}$/i
const OWNER_PAYOUT_AUTHORIZATION_MAX_FUTURE_MS = 120_000
const UINT256_MAX = (1n << 256n) - 1n

/**
 * Production USDT release requires a sponsor signature over the exact current
 * treasury, Fireblocks vault, agreement, limits and recipient policy. Environment
 * flags alone cannot authorize execution. The sponsor signature is deliberately
 * separate from the per-transfer owner signature and Fireblocks approval policy.
 */
export function treasuryPayoutExecutionState(preflightChecksPassed, releaseAuthorized = false) {
  const payoutsPreflightReady = preflightChecksPassed === true
  const sponsorReleaseAuthorized = releaseAuthorized === true
  const executionEnabled = payoutsPreflightReady && sponsorReleaseAuthorized
    && !REAL_VALUE_PAYOUT_EXECUTION_DISABLED
  return {
    payoutsPreflightReady,
    sponsorReleaseAuthorized,
    withdrawalsEnabled: executionEnabled,
    executionEnabled,
    executionBlocker: REAL_VALUE_PAYOUT_EXECUTION_DISABLED
      ? 'real-value-payout-execution-disabled-in-this-build'
      : !sponsorReleaseAuthorized
        ? 'real-value-payout-release-authorization-incomplete'
        : payoutsPreflightReady ? null : 'payout-preflight-incomplete',
  }
}

export function treasuryTrxPayoutExecutionState(preflightChecksPassed) {
  return {
    payoutsPreflightReady: preflightChecksPassed === true,
    sponsorReleaseAuthorized: false,
    withdrawalsEnabled: false,
    executionEnabled: false,
    executionBlocker: REAL_VALUE_TRX_PAYOUT_EXECUTION_DISABLED
      ? 'native-trx-payout-execution-disabled-in-this-build'
      : 'native-trx-release-authorization-required',
  }
}

export function buildTreasuryRealValueReleaseMessage(env = process.env, {
  now = Date.now(),
} = {}) {
  const config = treasuryUsdtConfiguration(env)
  const releaseReference = typeof env.TREASURY_REAL_VALUE_RELEASE_REFERENCE === 'string'
    ? env.TREASURY_REAL_VALUE_RELEASE_REFERENCE.trim() : ''
  const expiryRaw = typeof env.TREASURY_REAL_VALUE_RELEASE_EXPIRES_AT === 'string'
    ? env.TREASURY_REAL_VALUE_RELEASE_EXPIRES_AT.trim() : ''
  const expiresAt = /^\d{13}$/.test(expiryRaw) ? Number(expiryRaw) : NaN
  if (!config.configurationComplete || !config.featureFlagEnabled
    || !config.sponsorAgreementScopeApproved || !config.sponsorApproverAddressesValid) {
    throw new Error('Complete Mainnet USDT sponsor, owner, Fireblocks and policy configuration is required before requesting a release signature.')
  }
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(releaseReference)) {
    throw new Error('A unique sponsor release reference of 8–160 safe characters is required.')
  }
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(expiresAt)
    || expiresAt <= now || expiresAt > now + REAL_VALUE_RELEASE_MAX_FUTURE_MS) {
    throw new Error('The sponsor release expiry must be in the future and no more than 30 days away.')
  }
  const staticRecipients = [...config.allowedRecipientAddresses].sort()
  const sponsorApprovers = [...config.sponsorApproverAddresses].sort()
  const recipientPolicyHash = createHash('sha256').update(JSON.stringify({
    staticRecipients,
    sponsorApprovers,
  }), 'utf8').digest('hex')
  const treasuryAddress = env.TREASURY_ADDRESS.trim()
  const ownerAddress = env.TREASURY_OWNER_ADDRESS.trim()
  const vaultAccountId = String(env.FIREBLOCKS_VAULT_ACCOUNT_ID || '').trim()
  const usdtAssetId = String(env.FIREBLOCKS_USDT_ASSET_ID || '').trim()
  const trxAssetId = String(env.FIREBLOCKS_TRX_ASSET_ID || '').trim()
  return [
    'TRON Token Studio Mainnet USDT real-value payout release',
    'Version: 1',
    'Purpose: authorize the platform to submit real Mainnet USDT withdrawals only within the exact sponsor agreement, treasury, vault, destination policy and limits below.',
    'This does not waive Fireblocks transaction policy, owner per-transfer authorization, balance checks, idempotency, fee reserves or chain receipt verification.',
    'Network: TRON Mainnet',
    'Asset: genuine Tether USDT',
    `Token contract: ${USDT_MAINNET}`,
    `Sponsor organization reference: ${config.sponsorOrganizationReference}`,
    `Sponsor agreement reference: ${config.sponsorAgreementReference}`,
    `Treasury source address: ${treasuryAddress}`,
    `Owner authorization address: ${ownerAddress}`,
    `Fireblocks vault account ID: ${vaultAccountId}`,
    `Fireblocks USDT asset ID: ${usdtAssetId}`,
    `Fireblocks native TRX asset ID: ${trxAssetId}`,
    `Maximum single payout USDT: ${env.TREASURY_MAX_PAYOUT_USDT.trim()}`,
    `Daily USDT payout limit: ${env.TREASURY_DAILY_LIMIT_USDT.trim()}`,
    `Total sponsor USDT principal commitment: ${env.TREASURY_SPONSOR_TOTAL_BUDGET_USDT.trim()}`,
    `Maximum estimated network fee reserve SUN: ${env.TREASURY_FEE_LIMIT_SUN.trim()}`,
    `Recipient policy SHA-256: ${recipientPolicyHash}`,
    `Approved sponsor signer addresses: ${sponsorApprovers.join(',')}`,
    `Release reference: ${releaseReference}`,
    `Release expires at Unix milliseconds: ${expiresAt}`,
  ].join('\n')
}

export async function verifyTreasuryRealValueReleaseAuthorization(tronWeb, env = process.env, signature, {
  now = Date.now(),
} = {}) {
  if (env.TREASURY_REAL_VALUE_EXECUTION_ENABLED !== 'true') {
    return { authorized: false, reason: 'real-value-execution-switch-disabled' }
  }
  if (typeof signature !== 'string' || !OWNER_PAYOUT_SIGNATURE_PATTERN.test(signature)) {
    return { authorized: false, reason: 'sponsor-release-signature-missing-or-invalid' }
  }
  try {
    const message = buildTreasuryRealValueReleaseMessage(env, { now })
    const signerAddress = await recoverTreasurySponsorRecipientApprover(tronWeb, {
      message,
      signature,
      allowedSignerAddresses: treasuryUsdtConfiguration(env).sponsorApproverAddresses,
    })
    if (!signerAddress) return { authorized: false, reason: 'sponsor-release-signature-not-from-authorized-signer' }
    const expiresAt = Number(env.TREASURY_REAL_VALUE_RELEASE_EXPIRES_AT)
    return {
      authorized: true,
      reason: null,
      signerAddress,
      releaseReference: env.TREASURY_REAL_VALUE_RELEASE_REFERENCE.trim(),
      expiresAt,
      messageHash: createHash('sha256').update(message, 'utf8').digest('hex'),
      message,
    }
  } catch {
    return { authorized: false, reason: 'sponsor-release-configuration-or-signature-invalid' }
  }
}

export function buildTreasuryRealValueReleaseRevocationMessage({
  releaseReference,
  messageHash,
  sponsorOrganizationReference,
  sponsorAgreementReference,
  treasuryAddress,
  requesterOrigin,
} = {}) {
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(releaseReference || '')
    || !/^[0-9a-f]{64}$/i.test(messageHash || '')
    || !/^[A-Za-z0-9._:-]{8,128}$/.test(sponsorOrganizationReference || '')
    || !/^[A-Za-z0-9._:-]{8,160}$/.test(sponsorAgreementReference || '')
    || !isValidTronAddress(treasuryAddress)
    || typeof requesterOrigin !== 'string' || !normalizeTreasuryApprovalOrigin(requesterOrigin)
    || normalizeTreasuryApprovalOrigin(requesterOrigin) !== requesterOrigin) {
    throw new Error('A valid active sponsor release record is required for revocation.')
  }
  return [
    'TRON Token Studio Mainnet USDT real-value payout release revocation',
    'Version: 1',
    'Purpose: revoke the exact sponsor release authorization below. This does not cancel an already reserved or submitted Fireblocks transaction.',
    'Network: TRON Mainnet',
    'Asset: genuine Tether USDT',
    `Token contract: ${USDT_MAINNET}`,
    `Sponsor organization reference: ${sponsorOrganizationReference}`,
    `Sponsor agreement reference: ${sponsorAgreementReference}`,
    `Treasury source address: ${treasuryAddress}`,
    `Release reference: ${releaseReference}`,
    `Original release message SHA-256: ${messageHash.toLowerCase()}`,
    `Application origin: ${requesterOrigin}`,
  ].join('\n')
}
/**
 * Require the console's only permitted owner and the payout authorizer to be
 * the exact same TRON address. This prevents an accidental split-owner setup.
 */
export function parseTreasuryRecipientAllowlist(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192) {
    return { valid: false, addresses: [], reason: 'recipient-allowlist-not-configured' }
  }
  const entries = value.split(',').map((entry) => entry.trim())
  if (entries.length < 1 || entries.length > 100
    || entries.some((entry) => !entry || !isValidTronAddress(entry))) {
    return { valid: false, addresses: [], reason: 'recipient-allowlist-invalid' }
  }
  const addresses = [...new Set(entries)]
  if (addresses.length !== entries.length) {
    return { valid: false, addresses: [], reason: 'recipient-allowlist-contains-duplicates' }
  }
  return { valid: true, addresses, reason: null }
}

export function isTreasuryRecipientAllowed(recipientAddress, allowlist) {
  return typeof recipientAddress === 'string'
    && Array.isArray(allowlist)
    && allowlist.includes(recipientAddress)
}


const RECIPIENT_APPROVAL_REQUEST_TTL_MS = 24 * 60 * 60 * 1000
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SPONSOR_REFERENCE_PATTERN = /^[A-Za-z0-9._:-]{8,160}$/

export function parseTreasurySponsorApproverAllowlist(value, { excludedAddresses = [] } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    return { valid: false, addresses: [], reason: 'sponsor-approver-allowlist-not-configured' }
  }
  const entries = value.split(',').map((entry) => entry.trim())
  if (entries.length < 1 || entries.length > 20
    || entries.some((entry) => !isValidTronAddress(entry))) {
    return { valid: false, addresses: [], reason: 'sponsor-approver-allowlist-invalid' }
  }
  const addresses = [...new Set(entries)]
  if (addresses.length !== entries.length) {
    return { valid: false, addresses: [], reason: 'sponsor-approver-allowlist-contains-duplicates' }
  }
  const excluded = new Set(excludedAddresses
    .filter((address) => typeof address === 'string' && address.trim())
    .map((address) => address.trim()))
  if (addresses.some((address) => excluded.has(address))) {
    return { valid: false, addresses: [], reason: 'sponsor-approver-must-be-independent-of-owner-and-treasury' }
  }
  return { valid: true, addresses, reason: null }
}

function normalizeTreasuryApprovalOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const input = value.trim()
  if (input === 'tronstudio://app') return input
  try {
    const parsed = new URL(input)
    const local = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname.toLowerCase())
    if (!(parsed.protocol === 'https:' || local) || parsed.username || parsed.password
      || parsed.search || parsed.hash || (parsed.pathname !== '' && parsed.pathname !== '/')) return null
    return parsed.origin
  } catch {
    return null
  }
}

function isConfiguredTreasuryApprovalOrigin(origin, env) {
  const normalized = normalizeTreasuryApprovalOrigin(origin)
  if (!normalized || normalized !== origin) return false
  const allowed = [env.FRONTEND_ORIGIN, env.PACKAGED_APP_ORIGINS, env.OKX_UI_ORIGIN]
    .filter((value) => typeof value === 'string' && value.trim())
    .flatMap((value) => value.split(','))
    .map(normalizeTreasuryApprovalOrigin)
    .filter(Boolean)
  return allowed.includes(normalized)
}

export function buildTreasuryRecipientApprovalMessage({
  requestId,
  sponsorOrganizationReference,
  sponsorAgreementReference,
  treasuryAddress,
  recipientAddress,
  requesterAddress,
  requesterOrigin,
  reason,
  expiresAt,
} = {}) {
  if (typeof requestId !== 'string' || !UUID_PATTERN.test(requestId)
    || !SPONSOR_REFERENCE_PATTERN.test(sponsorOrganizationReference || '')
    || !SPONSOR_REFERENCE_PATTERN.test(sponsorAgreementReference || '')) {
    throw new Error('A valid recipient request and sponsor agreement reference are required.')
  }
  for (const [field, value] of Object.entries({ treasuryAddress, recipientAddress, requesterAddress })) {
    if (typeof value !== 'string' || !isValidTronAddress(value)) {
      throw new Error(`A valid TRON ${field} is required for sponsor recipient approval.`)
    }
  }
  if (typeof requesterOrigin !== 'string' || !normalizeTreasuryApprovalOrigin(requesterOrigin)
    || requesterOrigin !== normalizeTreasuryApprovalOrigin(requesterOrigin)) {
    throw new Error('A configured application origin is required for sponsor recipient approval.')
  }
  if (typeof reason !== 'string' || !/^[\x20-\x7e]{10,500}$/.test(reason.trim())) {
    throw new Error('A single-line recipient approval reason of at most 500 characters is required.')
  }
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    throw new Error('A valid recipient approval request expiry is required.')
  }
  return [
    'TRON Token Studio sponsor recipient approval',
    'Version: 1',
    'Purpose: approve this exact destination for the sponsor agreement; this signature does not authorize, sign, or execute a token transfer.',
    'Network: TRON Mainnet',
    'Asset: USDT',
    `Token contract: ${USDT_MAINNET}`,
    `Sponsor organization reference: ${sponsorOrganizationReference}`,
    `Sponsor agreement reference: ${sponsorAgreementReference}`,
    `Treasury source address: ${treasuryAddress}`,
    `Approved recipient: ${recipientAddress}`,
    `Requested by owner: ${requesterAddress}`,
    `Application origin: ${requesterOrigin}`,
    `Request ID: ${requestId}`,
    `Reason: ${reason.trim()}`,
    `Approval request expires at Unix milliseconds: ${expiresAt}`,
  ].join('\n')
}

export function buildTreasuryRecipientRevocationMessage({
  requestId,
  sponsorOrganizationReference,
  sponsorAgreementReference,
  treasuryAddress,
  recipientAddress,
  approvalMessageHash,
  requesterOrigin,
} = {}) {
  if (typeof requestId !== 'string' || !UUID_PATTERN.test(requestId)
    || !SPONSOR_REFERENCE_PATTERN.test(sponsorOrganizationReference || '')
    || !SPONSOR_REFERENCE_PATTERN.test(sponsorAgreementReference || '')
    || typeof approvalMessageHash !== 'string' || !/^[0-9a-f]{64}$/i.test(approvalMessageHash)) {
    throw new Error('A valid approved recipient record is required for revocation.')
  }
  for (const [field, value] of Object.entries({ treasuryAddress, recipientAddress })) {
    if (typeof value !== 'string' || !isValidTronAddress(value)) {
      throw new Error(`A valid TRON ${field} is required for sponsor recipient revocation.`)
    }
  }
  if (typeof requesterOrigin !== 'string' || requesterOrigin !== normalizeTreasuryApprovalOrigin(requesterOrigin)) {
    throw new Error('A configured application origin is required for sponsor recipient revocation.')
  }
  return [
    'TRON Token Studio sponsor recipient revocation',
    'Version: 1',
    'Purpose: revoke the prior destination approval identified below; this signature does not execute a token transfer.',
    'Network: TRON Mainnet',
    'Asset: USDT',
    `Token contract: ${USDT_MAINNET}`,
    `Sponsor organization reference: ${sponsorOrganizationReference}`,
    `Sponsor agreement reference: ${sponsorAgreementReference}`,
    `Treasury source address: ${treasuryAddress}`,
    `Recipient to revoke: ${recipientAddress}`,
    `Request ID: ${requestId}`,
    `Application origin: ${requesterOrigin}`,
    `Original approval message SHA-256: ${approvalMessageHash.toLowerCase()}`,
  ].join('\n')
}

export async function recoverTreasurySponsorRecipientApprover(tronWeb, {
  message,
  signature,
  allowedSignerAddresses = [],
} = {}) {
  if (typeof message !== 'string' || !message
    || typeof signature !== 'string' || !OWNER_PAYOUT_SIGNATURE_PATTERN.test(signature)
    || !Array.isArray(allowedSignerAddresses) || allowedSignerAddresses.length === 0
    || typeof tronWeb?.trx?.verifyMessageV2 !== 'function') return null
  try {
    const recoveredAddress = await tronWeb.trx.verifyMessageV2(message, signature)
    return typeof recoveredAddress === 'string' && allowedSignerAddresses.includes(recoveredAddress)
      ? recoveredAddress
      : null
  } catch {
    return null
  }
}

export async function verifyTreasurySponsorRecipientApproval(tronWeb, row, {
  allowedSignerAddresses = [],
} = {}) {
  if (!row || typeof row !== 'object' || row.status !== 'approved'
    || row.token_contract !== USDT_MAINNET
    || typeof row.approver_address !== 'string'
    || typeof row.approval_message_hash !== 'string'
    || !/^[0-9a-f]{64}$/i.test(row.approval_message_hash)) return false
  try {
    const approvalMessage = buildTreasuryRecipientApprovalMessage({
      requestId: row.request_id,
      sponsorOrganizationReference: row.sponsor_organization_reference,
      sponsorAgreementReference: row.sponsor_agreement_reference,
      treasuryAddress: row.treasury_address,
      recipientAddress: row.recipient_address,
      requesterAddress: row.requester_owner_address,
      requesterOrigin: row.requester_origin,
      reason: row.request_reason,
      expiresAt: new Date(row.approval_expires_at).getTime(),
    })
    const expectedHash = createHash('sha256').update(approvalMessage, 'utf8').digest('hex')
    if (expectedHash !== row.approval_message_hash.trim().toLowerCase()) return false
    const recoveredApprover = await recoverTreasurySponsorRecipientApprover(tronWeb, {
      message: approvalMessage,
      signature: row.approval_signature,
      allowedSignerAddresses,
    })
    return recoveredApprover === row.approver_address
  } catch {
    return false
  }
}

export function isUnifiedTreasuryOwnerConfiguration(env = process.env) {
  const consoleOwner = typeof env.OWNER_WALLET_ADDRESS === 'string' ? env.OWNER_WALLET_ADDRESS.trim() : ''
  const treasuryOwner = typeof env.TREASURY_OWNER_ADDRESS === 'string' ? env.TREASURY_OWNER_ADDRESS.trim() : ''
  return ADDRESS_PATTERN.test(consoleOwner)
    && ADDRESS_PATTERN.test(treasuryOwner)
    && consoleOwner === treasuryOwner
}

const ABI = [
  { constant: true, inputs: [{ name: 'owner', type: 'address' }], name: 'balanceOf', outputs: [{ name: 'balance', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { constant: true, inputs: [], name: 'decimals', outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view', type: 'function' },
  { constant: true, inputs: [], name: 'symbol', outputs: [{ name: '', type: 'string' }], stateMutability: 'view', type: 'function' },
  { constant: false, inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }], name: 'transfer', outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable', type: 'function' },
]

let pool
let schemaPromise
function getPool(env) {
  if (pool) return pool
  if (!env.DATABASE_URL) return null
  const connectionString = normalizeDatabaseConnectionString(env.DATABASE_URL)
  pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    max: 3,
    ssl: databaseSslConfig(connectionString, env),
  })
  pool.on('error', (error) => console.error('Treasury withdrawal database error:', error?.code || 'unknown'))
  return pool
}

async function ensureSchema(db) {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS trc20_token_clone.treasury_withdrawal_requests (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          owner_address TEXT NOT NULL,
          treasury_address TEXT NOT NULL,
          recipient_address TEXT NOT NULL,
          token_contract TEXT NOT NULL,
          sponsor_organization_reference TEXT,
          sponsor_agreement_reference TEXT,
          sponsor_agreement_budget_base_units NUMERIC(78,0),
          recipient_approval_request_id UUID,
          amount_base_units NUMERIC(78,0) NOT NULL CHECK (amount_base_units > 0),
          status TEXT NOT NULL CHECK (status IN ('broadcasting','provider-pending','broadcast-accepted','broadcast-unknown','rejected')),
          transaction_hash CHAR(64),
          provider_transaction_id TEXT,
          provider_status TEXT,
          failure_code TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `)
      await db.query(`ALTER TABLE trc20_token_clone.treasury_withdrawal_requests DROP CONSTRAINT IF EXISTS treasury_withdrawal_requests_status_check`)
      await db.query(`
        CREATE TABLE IF NOT EXISTS trc20_token_clone.treasury_recipient_approval_requests (
          request_id UUID PRIMARY KEY,
          sponsor_organization_reference TEXT NOT NULL,
          sponsor_agreement_reference TEXT NOT NULL,
          treasury_address TEXT NOT NULL,
          recipient_address TEXT NOT NULL,
          token_contract TEXT NOT NULL CHECK (token_contract = '${USDT_MAINNET}'),
          requester_owner_address TEXT NOT NULL,
          requester_origin TEXT NOT NULL,
          request_reason TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending','approved','expired','cancelled','revoked')),
          approval_message_hash CHAR(64) NOT NULL,
          approval_expires_at TIMESTAMPTZ NOT NULL,
          approver_address TEXT,
          approval_signature TEXT,
          approved_at TIMESTAMPTZ,
          revocation_message_hash CHAR(64),
          revoked_by TEXT,
          revocation_signature TEXT,
          revoked_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          CHECK ((status <> 'approved') OR (approver_address IS NOT NULL AND approval_signature IS NOT NULL AND approved_at IS NOT NULL)),
          CHECK ((status <> 'revoked') OR (revoked_by IS NOT NULL AND revocation_signature IS NOT NULL AND revoked_at IS NOT NULL))
        )
      `)
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS treasury_recipient_approval_active_idx
        ON trc20_token_clone.treasury_recipient_approval_requests
          (sponsor_organization_reference, sponsor_agreement_reference, treasury_address, recipient_address)
        WHERE status IN ('pending','approved')`)
      await db.query(`CREATE INDEX IF NOT EXISTS treasury_recipient_approval_lookup_idx
        ON trc20_token_clone.treasury_recipient_approval_requests
          (treasury_address, sponsor_organization_reference, sponsor_agreement_reference, recipient_address, status)`)
      await db.query(`
        CREATE TABLE IF NOT EXISTS trc20_token_clone.treasury_real_value_release_authorizations (
          release_authorization_id UUID PRIMARY KEY,
          release_reference TEXT NOT NULL,
          sponsor_organization_reference TEXT NOT NULL,
          sponsor_agreement_reference TEXT NOT NULL,
          treasury_address TEXT NOT NULL,
          requester_origin TEXT NOT NULL,
          release_message TEXT NOT NULL,
          release_message_hash CHAR(64) NOT NULL,
          release_expires_at TIMESTAMPTZ NOT NULL,
          sponsor_signer_address TEXT NOT NULL,
          sponsor_signature TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('active','revoked','expired','superseded')),
          revocation_message_hash CHAR(64),
          revoked_by TEXT,
          revocation_signature TEXT,
          revoked_at TIMESTAMPTZ,
          created_by_owner_address TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          CHECK ((status <> 'revoked') OR (revoked_by IS NOT NULL AND revocation_signature IS NOT NULL AND revoked_at IS NOT NULL))
        )
      `)
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS treasury_real_value_release_active_idx
        ON trc20_token_clone.treasury_real_value_release_authorizations (release_reference)
        WHERE status='active'`)
      await db.query(`CREATE INDEX IF NOT EXISTS treasury_real_value_release_lookup_idx
        ON trc20_token_clone.treasury_real_value_release_authorizations
          (release_reference, sponsor_organization_reference, sponsor_agreement_reference, treasury_address, status)`)

      await db.query(`ALTER TABLE trc20_token_clone.treasury_withdrawal_requests
        ADD CONSTRAINT treasury_withdrawal_requests_status_check
        CHECK (status IN ('broadcasting','provider-pending','broadcast-accepted','broadcast-unknown','rejected','confirmed','failed'))`)
      await db.query(`ALTER TABLE trc20_token_clone.treasury_withdrawal_requests ADD COLUMN IF NOT EXISTS provider_transaction_id TEXT`)
      await db.query(`ALTER TABLE trc20_token_clone.treasury_withdrawal_requests ADD COLUMN IF NOT EXISTS provider_status TEXT`)
      await db.query(`ALTER TABLE trc20_token_clone.treasury_withdrawal_requests ADD COLUMN IF NOT EXISTS sponsor_organization_reference TEXT`)
      await db.query(`ALTER TABLE trc20_token_clone.treasury_withdrawal_requests ADD COLUMN IF NOT EXISTS sponsor_agreement_reference TEXT`)
      await db.query(`ALTER TABLE trc20_token_clone.treasury_withdrawal_requests ADD COLUMN IF NOT EXISTS sponsor_agreement_budget_base_units NUMERIC(78,0)`)
      await db.query(`ALTER TABLE trc20_token_clone.treasury_withdrawal_requests ADD COLUMN IF NOT EXISTS recipient_approval_request_id UUID`)
      await db.query(`CREATE INDEX IF NOT EXISTS treasury_withdrawal_recipient_approval_idx
        ON trc20_token_clone.treasury_withdrawal_requests (recipient_approval_request_id)
        WHERE recipient_approval_request_id IS NOT NULL`)
      await db.query(`UPDATE trc20_token_clone.treasury_withdrawal_requests
        SET status='broadcast-unknown',
            failure_code='fireblocks-terminal-unverified-' || COALESCE(NULLIF(provider_status, ''), 'unknown'),
            updated_at=now()
        WHERE status='failed' AND COALESCE(failure_code, '') LIKE 'fireblocks-terminal-%'`)
      await db.query(`CREATE INDEX IF NOT EXISTS treasury_withdrawal_sponsor_agreement_idx
        ON trc20_token_clone.treasury_withdrawal_requests (treasury_address, sponsor_organization_reference, sponsor_agreement_reference, status)`)
      await db.query(`CREATE INDEX IF NOT EXISTS treasury_withdrawal_fee_reserve_idx
        ON trc20_token_clone.treasury_withdrawal_requests (treasury_address, status)`)
      await db.query(`
        CREATE TABLE IF NOT EXISTS trc20_token_clone.treasury_trx_withdrawal_requests (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          owner_address TEXT NOT NULL,
          treasury_address TEXT NOT NULL,
          recipient_address TEXT NOT NULL,
          amount_base_units NUMERIC(78,0) NOT NULL CHECK (amount_base_units > 0),
          status TEXT NOT NULL CHECK (status IN ('broadcasting','provider-pending','broadcast-accepted','broadcast-unknown','rejected')),
          transaction_hash CHAR(64),
          provider_transaction_id TEXT,
          provider_status TEXT,
          failure_code TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `)
      await db.query(`ALTER TABLE trc20_token_clone.treasury_trx_withdrawal_requests DROP CONSTRAINT IF EXISTS treasury_trx_withdrawal_requests_status_check`)
      await db.query(`ALTER TABLE trc20_token_clone.treasury_trx_withdrawal_requests
        ADD CONSTRAINT treasury_trx_withdrawal_requests_status_check
        CHECK (status IN ('broadcasting','provider-pending','broadcast-accepted','broadcast-unknown','rejected','confirmed','failed'))`)
      await db.query(`ALTER TABLE trc20_token_clone.treasury_trx_withdrawal_requests ADD COLUMN IF NOT EXISTS provider_transaction_id TEXT`)
      await db.query(`ALTER TABLE trc20_token_clone.treasury_trx_withdrawal_requests ADD COLUMN IF NOT EXISTS provider_status TEXT`)
      await db.query(`UPDATE trc20_token_clone.treasury_trx_withdrawal_requests
        SET status='broadcast-unknown',
            failure_code='fireblocks-terminal-unverified-' || COALESCE(NULLIF(provider_status, ''), 'unknown'),
            updated_at=now()
        WHERE status='failed' AND COALESCE(failure_code, '') LIKE 'fireblocks-terminal-%'`)
      await db.query(`CREATE INDEX IF NOT EXISTS treasury_trx_withdrawal_fee_reserve_idx
        ON trc20_token_clone.treasury_trx_withdrawal_requests (treasury_address, status)`)
    })().catch((error) => { schemaPromise = null; throw error })
  }
  await schemaPromise
}

function parsePositiveDecimal(value, decimals = 6) {
  // Request bodies are bounded by the API, but bound numeric input too: a huge
  // decimal string can waste CPU and a value above uint256 cannot fit a TRC-20.
  if (typeof value !== 'string' || value.length > 86
    || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  if (whole.length > 78 || fraction.length > decimals) return null
  const units = BigInt(whole) * (10n ** BigInt(decimals)) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0')
  return units > 0n && units <= UINT256_MAX ? units : null
}

function readLimit(value) {
  return typeof value === 'string' ? parsePositiveDecimal(value, 6) : null
}

/**
 * Calculate the remaining third-party USDT principal commitment using integer
 * six-decimal base units only. Unresolved reservations and confirmed payouts
 * consume the commitment; failed/rejected payouts are excluded by the caller.
 */
export function sponsorPrincipalBudgetCapMatches(totalBudgetBaseUnits, {
  minimumStoredBudgetBaseUnits = null,
  maximumStoredBudgetBaseUnits = null,
  unpinnedAgreementRows = '0',
} = {}) {
  const valid = (value) => typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value)
  if (!valid(totalBudgetBaseUnits) || BigInt(totalBudgetBaseUnits) <= 0n
    || typeof unpinnedAgreementRows !== 'string' || !/^(0|[1-9][0-9]*)$/.test(unpinnedAgreementRows)) return false
  if (BigInt(unpinnedAgreementRows) > 0n) return false
  if (minimumStoredBudgetBaseUnits === null && maximumStoredBudgetBaseUnits === null) return true
  return minimumStoredBudgetBaseUnits === totalBudgetBaseUnits
    && maximumStoredBudgetBaseUnits === totalBudgetBaseUnits
}

export function calculateSponsorPrincipalBudgetState(totalBudgetBaseUnits, usedBaseUnits, requestedBaseUnits = '0') {
  const valid = (value) => typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value)
  if (!valid(totalBudgetBaseUnits) || BigInt(totalBudgetBaseUnits) <= 0n
    || !valid(usedBaseUnits) || !valid(requestedBaseUnits)) return null
  const total = BigInt(totalBudgetBaseUnits)
  const used = BigInt(usedBaseUnits)
  const requested = BigInt(requestedBaseUnits)
  const remaining = total > used ? total - used : 0n
  return {
    totalBudgetBaseUnits: total.toString(),
    usedBaseUnits: used.toString(),
    remainingBaseUnits: remaining.toString(),
    requestedBaseUnits: requested.toString(),
    withinBudget: used + requested <= total,
  }
}

function formatUnitsDecimal(value, decimals = 6) {
  let units
  try { units = BigInt(String(value)) } catch { return null }
  if (units < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null
  const scale = 10n ** BigInt(decimals)
  const whole = units / scale
  const fraction = (units % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  return fraction ? whole.toString() + '.' + fraction : whole.toString()
}

/**
 * Conservative fee preflight. A treasury payout is enabled only when its actual
 * TRX balance covers the configured maximum fee cap. This route does not assume
 * a gas sponsor exists or treat an unverified delegation as fee coverage.
 */
export function treasuryFeeCapCovered(balanceSun, feeLimitSun) {
  const balance = typeof balanceSun === 'string' || typeof balanceSun === 'number' ? String(balanceSun) : ''
  const limit = typeof feeLimitSun === 'string' || typeof feeLimitSun === 'number' ? String(feeLimitSun) : ''
  if (!/^(0|[1-9][0-9]{0,20})$/.test(balance)
    || !/^[1-9][0-9]{0,9}$/.test(limit)) return false
  return BigInt(balance) >= BigInt(limit)
}

/**
 * Reserve one maximum fee cap for each unresolved payout plus the new request.
 * Counts come from the persistent payout ledger while holding the treasury lock.
 */
export function requiredTreasuryFeeReserveSun(feeLimitSun, pendingUsdtCount = '0', pendingTrxCount = '0') {
  const fee = typeof feeLimitSun === 'string' || typeof feeLimitSun === 'number' ? String(feeLimitSun) : ''
  const usdtCount = typeof pendingUsdtCount === 'string' || typeof pendingUsdtCount === 'number' ? String(pendingUsdtCount) : ''
  const trxCount = typeof pendingTrxCount === 'string' || typeof pendingTrxCount === 'number' ? String(pendingTrxCount) : ''
  if (!/^[1-9][0-9]{0,9}$/.test(fee) || BigInt(fee) > 1_000_000_000n
    || !/^(0|[1-9][0-9]{0,11})$/.test(usdtCount)
    || !/^(0|[1-9][0-9]{0,11})$/.test(trxCount)) return null
  const reserve = BigInt(fee) * (BigInt(usdtCount) + BigInt(trxCount) + 1n)
  return reserve > 999999999999999999999n ? null : reserve.toString()
}

/** Both chain-observed and provider-available TRX must cover the complete reserve. */
export function treasuryFeeReserveCovered(chainBalanceSun, providerAvailableSun, requiredReserveSun) {
  const chain = typeof chainBalanceSun === 'string' || typeof chainBalanceSun === 'number' ? String(chainBalanceSun) : ''
  const provider = typeof providerAvailableSun === 'string' || typeof providerAvailableSun === 'number' ? String(providerAvailableSun) : ''
  const required = typeof requiredReserveSun === 'string' || typeof requiredReserveSun === 'number' ? String(requiredReserveSun) : ''
  if (!/^(0|[1-9][0-9]{0,20})$/.test(chain)
    || !/^(0|[1-9][0-9]{0,20})$/.test(provider)
    || !/^[1-9][0-9]{0,20}$/.test(required)) return false
  return BigInt(chain) >= BigInt(required) && BigInt(provider) >= BigInt(required)
}

/**
 * Conservative balance available for a new treasury payout. Pending/ambiguous
 * withdrawals remain reserved until their chain outcome is reconciled.
 */
export function unreservedTreasuryBalance(balanceBaseUnits, outstandingReservationBaseUnits) {
  const balance = typeof balanceBaseUnits === 'string' ? balanceBaseUnits : String(balanceBaseUnits ?? '')
  const reserved = typeof outstandingReservationBaseUnits === 'string'
    ? outstandingReservationBaseUnits : String(outstandingReservationBaseUnits ?? '')
  if (!/^(0|[1-9][0-9]{0,77})$/.test(balance)
    || !/^(0|[1-9][0-9]{0,77})$/.test(reserved)) return null
  const balanceValue = BigInt(balance)
  const reservedValue = BigInt(reserved)
  return (balanceValue > reservedValue ? balanceValue - reservedValue : 0n).toString()
}

/** Idempotency keys are bound to the original owner, recipient and amount. */
export function matchesTreasuryWithdrawalRequest(row, {
  ownerAddress,
  treasuryAddress,
  recipientAddress,
  amountBaseUnits,
  sponsorOrganizationReference,
  sponsorAgreementReference,
  sponsorAgreementBudgetBaseUnits,
} = {}) {
  if (!row || typeof row !== 'object') return false
  try {
    return row.owner_address === ownerAddress
      && row.treasury_address === treasuryAddress
      && row.recipient_address === recipientAddress
      && row.token_contract === USDT_MAINNET
      && row.sponsor_organization_reference === sponsorOrganizationReference
      && row.sponsor_agreement_reference === sponsorAgreementReference
      && BigInt(String(row.sponsor_agreement_budget_base_units)) === BigInt(String(sponsorAgreementBudgetBaseUnits))
      && BigInt(String(row.amount_base_units)) === BigInt(String(amountBaseUnits))
  } catch {
    return false
  }
}

function bearerToken(req) {
  const value = req.get('authorization') || ''
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(value)
  return match ? match[1] : ''
}

function normalizedHex(value) {
  return typeof value === 'string' ? value.replace(/^0x/i, '').toLowerCase() : ''
}

/** Verify a one-request owner signature without ever accepting a private key from the client. */
export async function verifyTreasuryOwnerPayoutSignature(tronWeb, { message, signature, expectedOwnerAddress } = {}) {
  if (typeof message !== 'string' || !message
    || typeof expectedOwnerAddress !== 'string' || !ADDRESS_PATTERN.test(expectedOwnerAddress)
    || typeof signature !== 'string' || !OWNER_PAYOUT_SIGNATURE_PATTERN.test(signature)
    || typeof tronWeb?.trx?.verifyMessageV2 !== 'function') return false
  try {
    const recoveredAddress = await tronWeb.trx.verifyMessageV2(message, signature)
    return recoveredAddress === expectedOwnerAddress
  } catch {
    return false
  }
}

/**
 * Verify the exact official-USDT transfer intent against a transaction from
 * TRON's confirmed node and its execution receipt. This helper is pure apart
 * from the supplied SDK's address conversion and never trusts local UI status.
 */
export function verifyTreasuryTransferEvidence(tronWeb, {
  transaction,
  transactionInfo,
  transactionHash,
  treasuryAddress,
  recipientAddress,
  amountBaseUnits,
} = {}) {
  const pending = { verified: false, status: 'awaiting-confirmed-receipt', reason: 'confirmed-transaction-or-receipt-unavailable' }
  if (!tronWeb || !TXID_PATTERN.test(transactionHash || '')
    || !ADDRESS_PATTERN.test(treasuryAddress || '')
    || !ADDRESS_PATTERN.test(recipientAddress || '')
    || typeof amountBaseUnits !== 'string' || !/^[1-9][0-9]{0,77}$/.test(amountBaseUnits)) {
    return { verified: false, status: 'verification-mismatch', reason: 'invalid-verification-input' }
  }
  const txid = String(transaction?.txID || transaction?.txid || '').toLowerCase()
  const infoId = String(transactionInfo?.id || transactionInfo?.txID || transactionInfo?.txid || '').toLowerCase()
  if (txid !== transactionHash.toLowerCase() || infoId !== transactionHash.toLowerCase()
    || !Array.isArray(transaction?.raw_data?.contract)) return pending
  const operations = transaction.raw_data.contract
  if (operations.length !== 1 || operations[0]?.type !== 'TriggerSmartContract') {
    return { verified: false, status: 'verification-mismatch', reason: 'unexpected-transaction-operation' }
  }
  let expectedOwner
  let expectedRecipient
  let expectedContract
  try {
    expectedOwner = normalizedHex(tronWeb.address.toHex(treasuryAddress))
    expectedRecipient = normalizedHex(tronWeb.address.toHex(recipientAddress))
    expectedContract = normalizedHex(tronWeb.address.toHex(USDT_MAINNET))
  } catch {
    return { verified: false, status: 'verification-mismatch', reason: 'address-encoding-failed' }
  }
  const value = operations[0]?.parameter?.value
  if (normalizedHex(value?.owner_address) !== expectedOwner
    || normalizedHex(value?.contract_address) !== expectedContract) {
    return { verified: false, status: 'verification-mismatch', reason: 'sender-or-token-contract-mismatch' }
  }
  const receiverBytes = expectedRecipient.startsWith('41') ? expectedRecipient.slice(2) : expectedRecipient
  if (!/^[0-9a-f]{40}$/.test(receiverBytes)) {
    return { verified: false, status: 'verification-mismatch', reason: 'recipient-address-encoding-invalid' }
  }
  const expectedData = 'a9059cbb' + receiverBytes.padStart(64, '0')
    + BigInt(amountBaseUnits).toString(16).padStart(64, '0')
  if (normalizedHex(value?.data) !== expectedData) {
    return { verified: false, status: 'verification-mismatch', reason: 'recipient-or-amount-mismatch' }
  }
  if (!Number.isSafeInteger(transactionInfo?.blockNumber) || transactionInfo.blockNumber < 1) return pending
  const result = transactionInfo?.receipt?.result
  if (result === 'SUCCESS') {
    // A successful VM receipt alone is not enough to report that USDT moved:
    // require the event emitted by the official Tether TRON token contract.
    const transferTopic = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
    const contractAddress = expectedContract.replace(/^41(?=[0-9a-f]{40}$)/, '')
    const fromTopic = expectedOwner.replace(/^41(?=[0-9a-f]{40}$)/, '').padStart(64, '0')
    const toTopic = expectedRecipient.replace(/^41(?=[0-9a-f]{40}$)/, '').padStart(64, '0')
    const expectedData = BigInt(amountBaseUnits).toString(16).padStart(64, '0')
    const logs = Array.isArray(transactionInfo?.log) ? transactionInfo.log : []
    const tokenTransferLogs = logs.filter((log) => {
      const logAddress = normalizedHex(log?.address).replace(/^41(?=[0-9a-f]{40}$)/, '')
      return logAddress === contractAddress
        && Array.isArray(log?.topics)
        && normalizedHex(log.topics[0]) === transferTopic
    })
    const exactTransferEvents = tokenTransferLogs.filter((log) =>
      log.topics.length >= 3
      && normalizedHex(log.topics[1]).padStart(64, '0') === fromTopic
      && normalizedHex(log.topics[2]).padStart(64, '0') === toTopic
      && normalizedHex(log.data).padStart(64, '0') === expectedData)
    if (tokenTransferLogs.length !== 1 || exactTransferEvents.length !== 1) {
      return { verified: false, status: 'verification-mismatch', reason: 'official-usdt-transfer-event-missing-or-mismatched' }
    }
    return { verified: true, status: 'confirmed', reason: 'confirmed-solidified-successful-receipt-and-transfer-event', blockNumber: transactionInfo.blockNumber }
  }
  if (typeof result === 'string' && result.length > 0) {
    return { verified: true, status: 'failed', reason: 'confirmed-solidified-failed-receipt', blockNumber: transactionInfo.blockNumber }
  }
  return pending
}

function safeStatus(row) {
  return {
    idempotencyKey: row.idempotency_key,
    network: 'mainnet',
    asset: 'USDT',
    tokenContract: USDT_MAINNET,
    treasuryAddress: row.treasury_address,
    recipientAddress: row.recipient_address,
    amountBaseUnits: String(row.amount_base_units),
    ...(typeof row.sponsor_organization_reference === 'string' ? { sponsorOrganizationReference: row.sponsor_organization_reference } : {}),
    ...(typeof row.sponsor_agreement_reference === 'string' ? { sponsorAgreementReference: row.sponsor_agreement_reference } : {}),
    ...(row.sponsor_agreement_budget_base_units !== null && row.sponsor_agreement_budget_base_units !== undefined ? { sponsorAgreementBudgetBaseUnits: String(row.sponsor_agreement_budget_base_units) } : {}),
    ...(typeof row.recipient_approval_request_id === 'string' ? { recipientApprovalRequestId: row.recipient_approval_request_id } : {}),
    status: row.status,
    ...(row.transaction_hash ? { transactionHash: String(row.transaction_hash).trim() } : {}),
    ...(row.provider_transaction_id ? { providerTransactionId: String(row.provider_transaction_id) } : {}),
    ...(row.provider_status ? { providerStatus: String(row.provider_status) } : {}),
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

/**
 * A Fireblocks terminal state is not independent chain evidence. Only a state
 * written after the TRON solidified-receipt verifier may be reported as verified.
 */
export function fireblocksPayoutLedgerState(state = {}) {
  const transactionHash = typeof state.transactionHash === 'string' ? state.transactionHash.trim() : ''
  if (state.localStatus === 'broadcast-accepted' && TXID_PATTERN.test(transactionHash)) {
    return { status: 'broadcast-accepted', failureCode: null }
  }
  if (state.localStatus === 'failed' || state.terminalFailure === true) {
    const providerStatus = typeof state.providerStatus === 'string'
      ? state.providerStatus.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 48) || 'unknown'
      : 'unknown'
    return {
      status: 'broadcast-unknown',
      failureCode: 'fireblocks-terminal-unverified-' + providerStatus,
    }
  }
  return { status: 'provider-pending', failureCode: null }
}

export function terminalTreasuryWithdrawalVerification(row) {
  if (!row || typeof row !== 'object') return { terminal: false }

  if (row.status === 'confirmed') {
    return {
      terminal: true,
      success: true,
      verification: {
        verified: true,
        status: 'confirmed',
        reason: 'previously-verified-solidified-receipt',
      },
    }
  }

  if (row.status !== 'failed') return { terminal: false }

  const failureCode = typeof row.failure_code === 'string' ? row.failure_code : ''
  if (failureCode.startsWith('confirmed-solidified-')) {
    return {
      terminal: true,
      success: false,
      verification: {
        verified: true,
        status: 'failed',
        reason: failureCode,
      },
    }
  }

  // Provider terminal state is not chain proof; keep the request unresolved.
  return { terminal: false }
}

export function matchesTreasuryTrxWithdrawalRequest(row, {
  ownerAddress,
  treasuryAddress,
  recipientAddress,
  amountBaseUnits,
} = {}) {
  if (!row || typeof row !== 'object') return false
  try {
    return row.owner_address === ownerAddress
      && row.treasury_address === treasuryAddress
      && row.recipient_address === recipientAddress
      && BigInt(String(row.amount_base_units)) === BigInt(String(amountBaseUnits))
  } catch {
    return false
  }
}

function safeTrxStatus(row) {
  return {
    idempotencyKey: row.idempotency_key,
    network: 'mainnet',
    asset: 'TRX',
    tokenContract: null,
    treasuryAddress: row.treasury_address,
    recipientAddress: row.recipient_address,
    amountBaseUnits: String(row.amount_base_units),
    decimals: 6,
    status: row.status,
    ...(row.transaction_hash ? { transactionHash: String(row.transaction_hash).trim() } : {}),
    ...(row.provider_transaction_id ? { providerTransactionId: String(row.provider_transaction_id) } : {}),
    ...(row.provider_status ? { providerStatus: String(row.provider_status) } : {}),
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

export function treasuryUsdtConfiguration(env = process.env) {
  const provider = fireblocksConfiguration(env)
  const required = [
    'DATABASE_URL', 'OWNER_WALLET_ADDRESS', 'TREASURY_OWNER_ADDRESS',
    'TREASURY_ADDRESS', 'TREASURY_MAX_PAYOUT_USDT', 'TREASURY_DAILY_LIMIT_USDT',
    'TREASURY_SPONSOR_ORGANIZATION_REFERENCE', 'TREASURY_SPONSOR_AGREEMENT_REFERENCE',
    'TREASURY_SPONSOR_TOTAL_BUDGET_USDT',
    'TREASURY_FEE_LIMIT_SUN', 'FIREBLOCKS_TRX_ASSET_ID',
  ]
  const missing = required.filter((key) => typeof env[key] !== 'string' || !env[key].trim())
  if (!provider.trxAssetConfigured) missing.push('FIREBLOCKS_TRX_ASSET_ID')
  const ownerAddressesMatch = isUnifiedTreasuryOwnerConfiguration(env)
  const maxPayout = readLimit(env.TREASURY_MAX_PAYOUT_USDT)
  const dailyLimit = readLimit(env.TREASURY_DAILY_LIMIT_USDT)
  const sponsorTotalBudget = readLimit(env.TREASURY_SPONSOR_TOTAL_BUDGET_USDT)
  const recipientAllowlist = parseTreasuryRecipientAllowlist(env.TREASURY_ALLOWED_RECIPIENT_ADDRESSES)
  const sponsorApproverAllowlist = parseTreasurySponsorApproverAllowlist(env.TREASURY_SPONSOR_APPROVER_ADDRESSES, {
    excludedAddresses: [env.OWNER_WALLET_ADDRESS, env.TREASURY_OWNER_ADDRESS, env.TREASURY_ADDRESS],
  })
  const recipientPolicyConfigured = recipientAllowlist.valid || sponsorApproverAllowlist.valid
  if (!recipientPolicyConfigured) {
    missing.push('TREASURY_ALLOWED_RECIPIENT_ADDRESSES or TREASURY_SPONSOR_APPROVER_ADDRESSES (a valid static list or independent sponsor signer list is required)')
  }
  const recipientApprovalMode = recipientAllowlist.valid && sponsorApproverAllowlist.valid
    ? 'mixed'
    : recipientAllowlist.valid ? 'static'
      : sponsorApproverAllowlist.valid ? 'sponsor-signed'
        : 'unavailable'
  const sponsorOrganizationReference = typeof env.TREASURY_SPONSOR_ORGANIZATION_REFERENCE === 'string'
    ? env.TREASURY_SPONSOR_ORGANIZATION_REFERENCE.trim() : ''
  const sponsorAgreementReference = typeof env.TREASURY_SPONSOR_AGREEMENT_REFERENCE === 'string'
    ? env.TREASURY_SPONSOR_AGREEMENT_REFERENCE.trim() : ''
  const sponsorOrganizationPattern = /^[A-Za-z0-9._:-]{8,128}$/
  const sponsorAgreementPattern = /^[A-Za-z0-9._:-]{8,160}$/
  if (!sponsorOrganizationPattern.test(sponsorOrganizationReference)) missing.push('TREASURY_SPONSOR_ORGANIZATION_REFERENCE')
  if (!sponsorAgreementPattern.test(sponsorAgreementReference)) missing.push('TREASURY_SPONSOR_AGREEMENT_REFERENCE')
  const sponsorAgreementScopeApproved = isApprovedSponsorAgreementScope({
    consentReference: sponsorAgreementReference,
    budget: {
      sponsor_reference: sponsorOrganizationReference,
      sponsor_address: typeof env.TREASURY_ADDRESS === 'string' ? env.TREASURY_ADDRESS.trim() : '',
      network: 'mainnet',
      purpose: 'asset-grant',
      asset: 'USDT',
      token_contract: USDT_MAINNET,
    },
    env,
  })
  if (!sponsorAgreementScopeApproved) missing.push('SPONSOR_APPROVED_AGREEMENT_REFERENCES (exact Mainnet USDT sponsor scope required)')
  if (!sponsorTotalBudget) missing.push('TREASURY_SPONSOR_TOTAL_BUDGET_USDT')
  if (sponsorTotalBudget && ((maxPayout && maxPayout > sponsorTotalBudget)
    || (dailyLimit && dailyLimit > sponsorTotalBudget))) {
    missing.push('TREASURY_SPONSOR_TOTAL_BUDGET_USDT (must cover per-transfer and daily caps)')
  }
  const feeLimitValid = /^\d+$/.test(env.TREASURY_FEE_LIMIT_SUN || '')
    && Number(env.TREASURY_FEE_LIMIT_SUN) >= 1
    && Number(env.TREASURY_FEE_LIMIT_SUN) <= 1_000_000_000
  if (!provider.configured) missing.push(...provider.missing)
  const configurationComplete = env.TREASURY_SIGNER_MODE === 'fireblocks'
    && missing.length === 0 && ownerAddressesMatch
    && ADDRESS_PATTERN.test(env.TREASURY_ADDRESS || '')
    && Boolean(maxPayout) && Boolean(dailyLimit) && Boolean(sponsorTotalBudget)
    && Boolean(maxPayout && sponsorTotalBudget && maxPayout <= sponsorTotalBudget)
    && Boolean(dailyLimit && sponsorTotalBudget && dailyLimit <= sponsorTotalBudget)
    && feeLimitValid
  const featureFlagEnabled = env.TREASURY_WITHDRAWALS_ENABLED === 'true'
  return {
    enabled: featureFlagEnabled && configurationComplete,
    configurationComplete,
    featureFlagEnabled,
    missing: [...new Set(missing)],
    ownerAddressesMatch,
    sponsorOrganizationReference: sponsorOrganizationPattern.test(sponsorOrganizationReference) ? sponsorOrganizationReference : null,
    sponsorAgreementReference: sponsorAgreementPattern.test(sponsorAgreementReference) && sponsorAgreementScopeApproved ? sponsorAgreementReference : null,
    sponsorAgreementScopeApproved,
    recipientAllowlistValid: recipientAllowlist.valid,
    recipientAllowlistCount: recipientAllowlist.addresses.length,
    allowedRecipientAddresses: recipientAllowlist.addresses,
    sponsorApproverAddressesValid: sponsorApproverAllowlist.valid,
    sponsorApproverCount: sponsorApproverAllowlist.addresses.length,
    sponsorApproverAddresses: sponsorApproverAllowlist.addresses,
    recipientApprovalMode,
    sponsorTotalBudgetBaseUnits: sponsorTotalBudget === null ? null : sponsorTotalBudget.toString(),
    signerMode: env.TREASURY_SIGNER_MODE === 'fireblocks' ? 'fireblocks-managed' : 'not-configured',
    providerConfigured: provider.configured,
  }
}

export function trxConfiguration(env = process.env) {
  const provider = fireblocksConfiguration(env)
  const required = [
    'DATABASE_URL', 'OWNER_WALLET_ADDRESS', 'TREASURY_OWNER_ADDRESS',
    'TREASURY_ADDRESS', 'TREASURY_MAX_PAYOUT_TRX', 'TREASURY_DAILY_LIMIT_TRX',
    'TREASURY_FEE_LIMIT_SUN', 'FIREBLOCKS_TRX_ASSET_ID',
  ]
  const missing = required.filter((key) => typeof env[key] !== 'string' || !env[key].trim())
  if (!provider.providerConfigured) missing.push(...provider.providerMissing)
  if (!provider.trxAssetConfigured) missing.push('FIREBLOCKS_TRX_ASSET_ID')
  if (env.TREASURY_SIGNER_MODE !== 'fireblocks') missing.push('TREASURY_SIGNER_MODE=fireblocks')
  const ownerAddressesMatch = isUnifiedTreasuryOwnerConfiguration(env)
  const maxPayout = readLimit(env.TREASURY_MAX_PAYOUT_TRX)
  const dailyLimit = readLimit(env.TREASURY_DAILY_LIMIT_TRX)
  const feeLimit = typeof env.TREASURY_FEE_LIMIT_SUN === 'string' && /^\d+$/.test(env.TREASURY_FEE_LIMIT_SUN)
    ? BigInt(env.TREASURY_FEE_LIMIT_SUN) : 0n
  const configurationComplete = missing.length === 0
    && ownerAddressesMatch
    && ADDRESS_PATTERN.test(env.TREASURY_ADDRESS || '')
    && maxPayout !== null && dailyLimit !== null
    && feeLimit >= 1n && feeLimit <= 1_000_000_000n
  const featureFlagEnabled = env.TREASURY_TRX_WITHDRAWALS_ENABLED === 'true'
  return {
    enabled: featureFlagEnabled && configurationComplete,
    configurationComplete,
    featureFlagEnabled,
    missing: [...new Set(missing)],
    ownerAddressesMatch,
    maxPayout,
    dailyLimit,
    feeLimit,
    signerMode: env.TREASURY_SIGNER_MODE === 'fireblocks' ? 'fireblocks-managed' : 'not-configured',
  }
}
function nativeTrxIntentMatches(tronWeb, transaction, {
  treasuryAddress,
  recipientAddress,
  amountBaseUnits,
} = {}) {
  const contracts = transaction?.raw_data?.contract
  if (!Array.isArray(contracts) || contracts.length !== 1 || contracts[0]?.type !== 'TransferContract') return false
  try {
    const expectedFrom = normalizedHex(tronWeb.address.toHex(treasuryAddress))
    const expectedTo = normalizedHex(tronWeb.address.toHex(recipientAddress))
    const value = contracts[0]?.parameter?.value
    if (!expectedFrom || !expectedTo
      || normalizedHex(value?.owner_address) !== expectedFrom
      || normalizedHex(value?.to_address) !== expectedTo
      || !/^(0|[1-9][0-9]{0,77})$/.test(String(value?.amount))) return false
    return BigInt(String(value.amount)) === BigInt(String(amountBaseUnits))
  } catch {
    return false
  }
}

/** Verify an exact native TRX transfer in a confirmed/solidified transaction. */
export function verifyTreasuryTrxTransferEvidence(tronWeb, {
  transaction,
  transactionInfo,
  transactionHash,
  treasuryAddress,
  recipientAddress,
  amountBaseUnits,
} = {}) {
  const pending = { verified: false, status: 'awaiting-confirmed-receipt', reason: 'confirmed-transaction-or-receipt-unavailable' }
  if (!tronWeb || !TXID_PATTERN.test(transactionHash || '')
    || !ADDRESS_PATTERN.test(treasuryAddress || '')
    || !ADDRESS_PATTERN.test(recipientAddress || '')
    || typeof amountBaseUnits !== 'string' || !/^[1-9][0-9]{0,77}$/.test(amountBaseUnits)) {
    return { verified: false, status: 'verification-mismatch', reason: 'invalid-verification-input' }
  }
  const txid = String(transaction?.txID || transaction?.txid || '').toLowerCase()
  const infoId = String(transactionInfo?.id || transactionInfo?.txID || transactionInfo?.txid || '').toLowerCase()
  if (txid !== transactionHash.toLowerCase() || infoId !== transactionHash.toLowerCase()
    || !nativeTrxIntentMatches(tronWeb, transaction, { treasuryAddress, recipientAddress, amountBaseUnits })) {
    return transaction && transactionInfo ? { verified: false, status: 'verification-mismatch', reason: 'native-transfer-intent-mismatch' } : pending
  }
  if (!Number.isSafeInteger(transactionInfo?.blockNumber) || transactionInfo.blockNumber < 1) return pending
  const receiptResult = transactionInfo?.receipt?.result
  if (typeof receiptResult !== 'string' || receiptResult.length === 0) {
    // A block number and matching transaction body are not enough to prove
    // execution succeeded. Keep the request pending until the solidified
    // transaction-info endpoint returns an explicit receipt result.
    return pending
  }
  if (receiptResult !== 'SUCCESS') {
    return { verified: true, status: 'failed', reason: 'confirmed-solidified-failed-transfer', blockNumber: transactionInfo.blockNumber }
  }
  const transactionResults = Array.isArray(transaction?.ret)
    ? transaction.ret.map((item) => item?.contractRet).filter((value) => typeof value === 'string' && value.length > 0)
    : []
  if (transactionResults.some((value) => value !== 'SUCCESS')) {
    return { verified: false, status: 'verification-mismatch', reason: 'execution-result-conflicts-with-confirmed-receipt' }
  }
  // Native TransferContract has no contract event. Confirmation therefore
  // requires the exact solidified transfer intent plus an explicit SUCCESS
  // execution receipt from the solidified transaction-info response.
  return {
    verified: true,
    status: 'confirmed',
    reason: 'confirmed-solidified-successful-native-transfer',
    blockNumber: transactionInfo.blockNumber,
  }
}


/**
 * Owner-only treasury-backed withdrawals. The owner signs in with the existing
 * wallet-auth challenge; the server signs transfers from a separate treasury
 * key. The signer is disabled unless explicitly opted in. This route never
 * mints tokens and only transfers USDT already held by the configured treasury.
 */
export function createTreasuryWithdrawalsRouter({
  env = process.env,
  sessionLookup = getWalletAuthSession,
  tronWebFactory = (privateKey) => new TronWeb({
    fullHost: MAINNET_RPC,
    ...(privateKey ? { privateKey } : {}),
    ...(typeof env.TRONGRID_API_KEY === 'string' && env.TRONGRID_API_KEY.trim()
      ? { headers: { 'TRON-PRO-API-KEY': env.TRONGRID_API_KEY.trim() } }
      : {}),
  }),
  fireblocksClientFactory = (currentEnv) => createFireblocksClient(currentEnv),
  now = () => new Date(),
} = {}) {
  const router = Router()
  const managedSigner = () => fireblocksClientFactory(env)
  async function currentRealValueReleaseAuthorization() {
    if (env.TREASURY_REAL_VALUE_EXECUTION_ENABLED !== 'true') {
      return { authorized: false, reason: 'real-value-execution-switch-disabled' }
    }
    const db = getPool(env)
    if (!db) return { authorized: false, reason: 'release-authorization-database-not-configured' }
    try {
      await ensureSchema(db)
      const clock = now()
      const nowMs = clock instanceof Date ? clock.getTime() : Number(clock)
      const message = buildTreasuryRealValueReleaseMessage(env, { now: nowMs })
      const messageHash = createHash('sha256').update(message, 'utf8').digest('hex')
      const result = await db.query(`SELECT *
        FROM trc20_token_clone.treasury_real_value_release_authorizations
        WHERE release_reference=$1 AND sponsor_organization_reference=$2
          AND sponsor_agreement_reference=$3 AND treasury_address=$4
          AND release_message_hash=$5 AND status='active'
          AND release_expires_at > now()
        ORDER BY created_at DESC LIMIT 1`, [
        env.TREASURY_REAL_VALUE_RELEASE_REFERENCE.trim(),
        configuration().sponsorOrganizationReference,
        configuration().sponsorAgreementReference,
        env.TREASURY_ADDRESS.trim(),
        messageHash,
      ])
      const row = result.rows[0]
      if (!row) return { authorized: false, reason: 'sponsor-release-signature-not-recorded-or-scope-changed' }
      const verified = await verifyTreasuryRealValueReleaseAuthorization(tronWebFactory(), env, row.sponsor_signature, { now: nowMs })
      if (!verified.authorized || verified.signerAddress !== row.sponsor_signer_address) {
        return { authorized: false, reason: 'sponsor-release-record-signature-mismatch' }
      }
      return verified
    } catch {
      return { authorized: false, reason: 'sponsor-release-authorization-storage-unavailable' }
    }
  }

  async function lockCurrentRealValueReleaseAuthorization(client) {
    if (env.TREASURY_REAL_VALUE_EXECUTION_ENABLED !== 'true') {
      return { authorized: false, reason: 'real-value-execution-switch-disabled' }
    }
    const clock = now()
    const nowMs = clock instanceof Date ? clock.getTime() : Number(clock)
    const config = configuration()
    const message = buildTreasuryRealValueReleaseMessage(env, { now: nowMs })
    const messageHash = createHash('sha256').update(message, 'utf8').digest('hex')
    const result = await client.query(`SELECT *
      FROM trc20_token_clone.treasury_real_value_release_authorizations
      WHERE release_reference=$1 AND sponsor_organization_reference=$2
        AND sponsor_agreement_reference=$3 AND treasury_address=$4
        AND release_message_hash=$5 AND status='active'
        AND release_expires_at > now()
      ORDER BY created_at DESC LIMIT 1 FOR SHARE`, [
      env.TREASURY_REAL_VALUE_RELEASE_REFERENCE.trim(),
      config.sponsorOrganizationReference,
      config.sponsorAgreementReference,
      env.TREASURY_ADDRESS.trim(),
      messageHash,
    ])
    const row = result.rows[0]
    if (!row) return { authorized: false, reason: 'sponsor-release-signature-not-recorded-or-scope-changed' }
    const verified = await verifyTreasuryRealValueReleaseAuthorization(tronWebFactory(), env, row.sponsor_signature, { now: nowMs })
    if (!verified.authorized || verified.signerAddress !== row.sponsor_signer_address) {
      return { authorized: false, reason: 'sponsor-release-record-signature-mismatch' }
    }
    return verified
  }

  async function authenticateOwner(req) {
    const origin = req.get('origin')
    const token = bearerToken(req)
    const expectedOwner = typeof env.TREASURY_OWNER_ADDRESS === 'string' ? env.TREASURY_OWNER_ADDRESS.trim() : ''
    if (!token || !origin || !ADDRESS_PATTERN.test(expectedOwner)) return { ok: false, status: 401, error: 'owner-auth-required' }
    // The UI login identity and treasury signing identity must be one and the
    // same configured wallet. Fail closed if environment settings drift apart.
    if (!isUnifiedTreasuryOwnerConfiguration(env)) {
      return { ok: false, status: 503, error: 'owner-address-configuration-mismatch' }
    }
    const result = await sessionLookup({
      tokenHash: createHash('sha256').update(token, 'utf8').digest('hex'),
      origin,
    })
    if (!result?.success || !result.session) return { ok: false, status: 401, error: 'invalid-or-expired-session' }
    if (result.session.network !== 'mainnet' || result.session.address !== expectedOwner || result.session.origin !== origin) {
      return { ok: false, status: 403, error: 'treasury-owner-only' }
    }
    return { ok: true, ownerAddress: expectedOwner }
  }

  function configuration() {
    return treasuryUsdtConfiguration(env)
  }

  async function readManagedTreasurySnapshot(treasuryAddress) {
    const fireblocks = managedSigner()
    if (typeof fireblocks?.isConfigured !== 'function' || fireblocks.isConfigured() !== true) {
      return { ok: false, reason: 'fireblocks-not-configured' }
    }
    const trxAssetId = typeof env.FIREBLOCKS_TRX_ASSET_ID === 'string' ? env.FIREBLOCKS_TRX_ASSET_ID.trim() : ''
    if (typeof fireblocks?.isTrxAssetConfigured !== 'function'
      || fireblocks.isTrxAssetConfigured() !== true || !trxAssetId) {
      return { ok: false, reason: 'fireblocks-trx-asset-not-configured' }
    }
    try {
      const tronWeb = tronWebFactory()
      if (!tronWeb?.isAddress?.(treasuryAddress) || typeof tronWeb.contract !== 'function'
        || typeof tronWeb?.trx?.getBalance !== 'function') {
        return { ok: false, reason: 'tron-read-provider-unavailable' }
      }
      const usdtAssetId = String(env.FIREBLOCKS_USDT_ASSET_ID || '').trim()
      const configuredVaultId = String(env.FIREBLOCKS_VAULT_ACCOUNT_ID || '').trim()
      const [
        vaultAccount,
        assetMetadata, providerAsset, addressResponse,
        trxAssetMetadata, providerTrxAsset, trxAddressResponse,
      ] = await Promise.all([
        fireblocks.getVaultAccount(),
        fireblocks.getAssetMetadata(),
        fireblocks.getVaultAccountAsset(),
        fireblocks.getAssetAddresses(),
        fireblocks.getAssetMetadata(trxAssetId),
        fireblocks.getVaultAccountAsset(trxAssetId),
        fireblocks.getAssetAddresses(trxAssetId),
      ])
      if (String(vaultAccount?.id ?? '') !== configuredVaultId) {
        return { ok: false, reason: 'fireblocks-vault-account-id-mismatch' }
      }
      const activeAssetIds = Array.isArray(vaultAccount?.assets)
        ? new Set(vaultAccount.assets.map((asset) => String(asset?.id || '')).filter(Boolean))
        : new Set()
      if (!activeAssetIds.has(usdtAssetId)) {
        return { ok: false, reason: 'fireblocks-usdt-asset-not-activated-in-vault' }
      }
      if (!activeAssetIds.has(trxAssetId)) {
        return { ok: false, reason: 'fireblocks-trx-asset-not-activated-in-vault' }
      }
      if (!fireblocksAssetIdentifierMatches(assetMetadata, String(env.FIREBLOCKS_USDT_ASSET_ID || ''))
        || (providerAsset?.id !== undefined && String(providerAsset.id) !== String(env.FIREBLOCKS_USDT_ASSET_ID || ''))
        || !isOfficialFireblocksUsdtAsset(assetMetadata, tronWeb, USDT_MAINNET)) {
        return { ok: false, reason: 'fireblocks-asset-not-official-tron-usdt' }
      }
      const addresses = [...new Set(extractFireblocksAddresses(addressResponse))]
      if (addresses.length !== 1 || addresses[0] !== treasuryAddress) {
        return { ok: false, reason: 'fireblocks-vault-address-mismatch' }
      }
      if (!isNativeFireblocksTrxAsset(trxAssetMetadata, trxAssetId)
        || (providerTrxAsset?.id !== undefined && !fireblocksAssetIdentifierMatches(providerTrxAsset, trxAssetId))) {
        return { ok: false, reason: 'fireblocks-asset-not-native-trx' }
      }
      const trxAddresses = [...new Set(extractFireblocksAddresses(trxAddressResponse))]
      if (trxAddresses.length !== 1 || trxAddresses[0] !== treasuryAddress) {
        return { ok: false, reason: 'fireblocks-trx-vault-address-mismatch' }
      }
      const providerAvailable = providerAssetAvailableBaseUnits(providerAsset)
      const providerAvailableTrx = providerAssetAvailableBaseUnits(providerTrxAsset)
      if (providerAvailable === null) return { ok: false, reason: 'fireblocks-available-balance-unavailable' }
      if (providerAvailableTrx === null) return { ok: false, reason: 'fireblocks-trx-available-balance-unavailable' }
      const [nativeBalance, contract] = await Promise.all([
        tronWeb.trx.getBalance(treasuryAddress), tronWeb.contract(ABI).at(USDT_MAINNET),
      ])
      const nativeText = String(nativeBalance)
      if (!/^(0|[1-9][0-9]{0,20})$/.test(nativeText)) return { ok: false, reason: 'treasury-trx-balance-unavailable' }
      const [decimals, symbol, rawBalance] = await Promise.all([
        contract.decimals().call(), contract.symbol().call(), contract.balanceOf(treasuryAddress).call(),
      ])
      const balanceText = String(rawBalance)
      if (Number(decimals) !== 6 || String(symbol).toUpperCase() !== 'USDT'
        || !/^(0|[1-9][0-9]{0,77})$/.test(balanceText)) {
        return { ok: false, reason: 'official-token-balance-unverified' }
      }
      const chainBalance = BigInt(balanceText)
      const providerAvailableUnits = BigInt(providerAvailable)
      const spendable = chainBalance < providerAvailableUnits ? chainBalance : providerAvailableUnits
      const feeCapSun = /^\d+$/.test(env.TREASURY_FEE_LIMIT_SUN || '') ? String(env.TREASURY_FEE_LIMIT_SUN) : null
      return {
        ok: true, treasuryAddress, providerAssetId: String(assetMetadata.id),
        providerAvailableBaseUnits: providerAvailable.toString(),
        treasuryUsdtBalanceBaseUnits: chainBalance.toString(),
        spendableUsdtBaseUnits: spendable.toString(),
        treasuryTrxBalanceSun: nativeText,
        providerAvailableTrxBaseUnits: providerAvailableTrx.toString(),
        treasuryFeeLimitSun: feeCapSun,
        networkFeeCapCovered: treasuryFeeCapCovered(nativeText, feeCapSun)
          && treasuryFeeCapCovered(providerAvailableTrx, feeCapSun),
        contractMetadataVerified: true, vaultAddressVerified: true,
        vaultAccountVerified: true, usdtAssetActivated: true, trxAssetActivated: true,
        nativeTrxAssetIdentityVerified: true, nativeTrxVaultAddressVerified: true,
      }
    } catch {
      return { ok: false, reason: 'provider-or-chain-read-unavailable' }
    }
  }


  /**
   * Read-only Fireblocks + TRON snapshot for native TRX payouts. The usable
   * amount is the lower of provider-available TRX and actual on-chain TRX.
   */
  async function readManagedTreasuryTrxSnapshot(treasuryAddress) {
    const fireblocks = managedSigner()
    const assetId = typeof env.FIREBLOCKS_TRX_ASSET_ID === 'string' ? env.FIREBLOCKS_TRX_ASSET_ID.trim() : ''
    // Native TRX requires shared provider authentication and its own verified asset
    // ID; do not require the unrelated USDT asset ID to be configured.
    if (typeof fireblocks?.isTrxAssetConfigured !== 'function'
      || fireblocks.isTrxAssetConfigured() !== true
      || !assetId) {
      return { ok: false, reason: 'fireblocks-trx-asset-not-configured' }
    }
    try {
      const tronWeb = tronWebFactory()
      if (!tronWeb?.isAddress?.(treasuryAddress) || typeof tronWeb?.trx?.getBalance !== 'function') {
        return { ok: false, reason: 'tron-read-provider-unavailable' }
      }
      const [assetMetadata, providerAsset, addressResponse] = await Promise.all([
        fireblocks.getAssetMetadata(assetId),
        fireblocks.getVaultAccountAsset(assetId),
        fireblocks.getAssetAddresses(assetId),
      ])
      if (!isNativeFireblocksTrxAsset(assetMetadata, assetId)
        || (providerAsset?.id !== undefined && !fireblocksAssetIdentifierMatches(providerAsset, assetId))) {
        return { ok: false, reason: 'fireblocks-asset-not-native-trx' }
      }
      const addresses = [...new Set(extractFireblocksAddresses(addressResponse))]
      if (addresses.length !== 1 || addresses[0] !== treasuryAddress) {
        return { ok: false, reason: 'fireblocks-vault-address-mismatch' }
      }
      const providerAvailable = providerAssetAvailableBaseUnits(providerAsset)
      if (providerAvailable === null) return { ok: false, reason: 'fireblocks-trx-available-balance-unavailable' }
      const nativeText = String(await tronWeb.trx.getBalance(treasuryAddress))
      if (!/^(0|[1-9][0-9]{0,20})$/.test(nativeText)) return { ok: false, reason: 'treasury-trx-balance-unavailable' }
      const chainUnits = BigInt(nativeText)
      const providerUnits = BigInt(providerAvailable)
      const spendableUnits = chainUnits < providerUnits ? chainUnits : providerUnits
      return {
        ok: true,
        treasuryAddress,
        providerAssetId: String(assetMetadata.legacyId || assetMetadata.id || assetId),
        providerAvailableBaseUnits: providerUnits.toString(),
        treasuryTrxBalanceSun: nativeText,
        spendableTrxBaseUnits: spendableUnits.toString(),
        vaultAddressVerified: true,
        nativeAssetIdentityVerified: true,
      }
    } catch {
      return { ok: false, reason: 'fireblocks-or-tron-trx-read-unavailable' }
    }
  }

  async function refreshProviderTransaction(db, row) {
    if (!row || ['confirmed', 'failed', 'rejected'].includes(row.status)) return row
    try {
      const fireblocks = managedSigner()
      let providerTx
      if (row.provider_transaction_id) {
        providerTx = await fireblocks.getTransaction(String(row.provider_transaction_id))
      } else if (row.idempotency_key) {
        // Resolve unknown outcomes by the provider's external id before allowing
        // any further action. This is lookup-only; it never creates a transfer.
        providerTx = await fireblocks.findTransactionByExternalId(String(row.idempotency_key))
      } else {
        return row
      }
      const providerId = typeof providerTx?.id === 'string' ? providerTx.id
        : typeof providerTx?.transactionId === 'string' ? providerTx.transactionId
          : String(row.provider_transaction_id || '')
      if (!providerId) return row
      const state = classifyFireblocksTransaction(providerTx)
      const ledgerState = fireblocksPayoutLedgerState(state)
      const nextStatus = ledgerState.status
      const updated = await db.query(
        `UPDATE trc20_token_clone.treasury_withdrawal_requests
            SET status=$2, transaction_hash=COALESCE($3, transaction_hash),
                provider_transaction_id=$4, provider_status=$5,
                failure_code=$6, updated_at=now()
          WHERE id=$1 RETURNING *`,
        [row.id, nextStatus, state.transactionHash, providerId, state.providerStatus,
          ledgerState.failureCode],
      )
      return updated.rows[0] || row
    } catch {
      return row
    }
  }


  async function refreshProviderTrxTransaction(db, row) {
    if (!row || ['confirmed', 'failed', 'rejected'].includes(row.status)) return row
    try {
      const fireblocks = managedSigner()
      let providerTx
      if (row.provider_transaction_id) {
        providerTx = await fireblocks.getTransaction(String(row.provider_transaction_id))
      } else if (row.idempotency_key) {
        providerTx = await fireblocks.findTransactionByExternalId(String(row.idempotency_key))
      } else {
        return row
      }
      const providerId = typeof providerTx?.id === 'string' ? providerTx.id
        : typeof providerTx?.transactionId === 'string' ? providerTx.transactionId
          : String(row.provider_transaction_id || '')
      if (!providerId) return row
      const state = classifyFireblocksTransaction(providerTx)
      const ledgerState = fireblocksPayoutLedgerState(state)
      const nextStatus = ledgerState.status
      const updated = await db.query(
        `UPDATE trc20_token_clone.treasury_trx_withdrawal_requests
            SET status=$2, transaction_hash=COALESCE($3, transaction_hash),
                provider_transaction_id=$4, provider_status=$5,
                failure_code=$6, updated_at=now()
          WHERE id=$1 RETURNING *`,
        [row.id, nextStatus, state.transactionHash, providerId, state.providerStatus,
          ledgerState.failureCode],
      )
      return updated.rows[0] || row
    } catch {
      return row
    }
  }


  router.post('/recipient-approval-requests', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const config = configuration()
    const origin = req.get('origin')
    if (!isConfiguredTreasuryApprovalOrigin(origin, env)) {
      return res.status(403).json({ success: false, error: 'recipient-approval-origin-not-allowed' })
    }
    if (!config.sponsorAgreementScopeApproved || !config.sponsorApproverAddressesValid) {
      return res.status(503).json({
        success: false,
        error: 'sponsor-recipient-approval-not-configured',
        requiredEnvironment: ['TREASURY_SPONSOR_APPROVER_ADDRESSES (independent sponsor-controlled TRON signer addresses)'],
      })
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).some((key) => !['recipientAddress', 'reason'].includes(key))
      || !isValidTronAddress(body.recipientAddress)
      || typeof body.reason !== 'string' || !/^[\x20-\x7e]{10,500}$/.test(body.reason.trim())) {
      return res.status(400).json({ success: false, error: 'invalid-recipient-approval-request' })
    }
    const treasuryAddress = typeof env.TREASURY_ADDRESS === 'string' ? env.TREASURY_ADDRESS.trim() : ''
    if (!isValidTronAddress(treasuryAddress) || body.recipientAddress === treasuryAddress) {
      return res.status(400).json({ success: false, error: 'invalid-treasury-or-recipient' })
    }
    if (isTreasuryRecipientAllowed(body.recipientAddress, config.allowedRecipientAddresses)) {
      return res.status(409).json({ success: false, error: 'recipient-already-in-static-sponsor-policy' })
    }
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      await db.query(`UPDATE trc20_token_clone.treasury_recipient_approval_requests
        SET status='expired', updated_at=now()
        WHERE status='pending' AND approval_expires_at <= now()`)
      const existing = await db.query(`SELECT request_id, status
        FROM trc20_token_clone.treasury_recipient_approval_requests
        WHERE sponsor_organization_reference=$1 AND sponsor_agreement_reference=$2
          AND treasury_address=$3 AND recipient_address=$4
          AND status IN ('pending','approved')
        LIMIT 1`, [
        config.sponsorOrganizationReference, config.sponsorAgreementReference,
        treasuryAddress, body.recipientAddress,
      ])
      if (existing.rows.length) {
        return res.status(409).json({
          success: false,
          error: existing.rows[0].status === 'approved' ? 'recipient-already-sponsor-approved' : 'recipient-approval-request-already-pending',
          requestId: existing.rows[0].request_id,
        })
      }
      const recentRequests = await db.query(`SELECT COUNT(*)::text AS count
        FROM trc20_token_clone.treasury_recipient_approval_requests
        WHERE requester_owner_address=$1 AND created_at > now() - interval '24 hours'`,
      [auth.ownerAddress])
      if (BigInt(recentRequests.rows[0]?.count || '0') >= 20n) {
        return res.status(429).json({
          success: false,
          error: 'recipient-approval-request-rate-limited',
          message: 'The owner may create at most 20 recipient approval requests in a rolling 24-hour window.',
        })
      }
      const current = now()
      const currentMs = current instanceof Date ? current.getTime() : Number(current)
      if (!Number.isSafeInteger(currentMs)) return res.status(503).json({ success: false, error: 'clock-unavailable' })
      const requestId = randomUUID()
      const expiresAt = currentMs + RECIPIENT_APPROVAL_REQUEST_TTL_MS
      const approvalMessage = buildTreasuryRecipientApprovalMessage({
        requestId,
        sponsorOrganizationReference: config.sponsorOrganizationReference,
        sponsorAgreementReference: config.sponsorAgreementReference,
        treasuryAddress,
        recipientAddress: body.recipientAddress,
        requesterAddress: auth.ownerAddress,
        requesterOrigin: origin,
        reason: body.reason.trim(),
        expiresAt,
      })
      const approvalMessageHash = createHash('sha256').update(approvalMessage, 'utf8').digest('hex')
      const inserted = await db.query(`INSERT INTO trc20_token_clone.treasury_recipient_approval_requests
        (request_id, sponsor_organization_reference, sponsor_agreement_reference,
         treasury_address, recipient_address, token_contract, requester_owner_address,
         requester_origin, request_reason, status, approval_message_hash, approval_expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,to_timestamp($11 / 1000.0))
        RETURNING request_id, status, created_at, approval_expires_at`, [
        requestId, config.sponsorOrganizationReference, config.sponsorAgreementReference,
        treasuryAddress, body.recipientAddress, USDT_MAINNET, auth.ownerAddress, origin,
        body.reason.trim(), approvalMessageHash, expiresAt,
      ])
      return res.status(201).json({
        success: true,
        request: {
          requestId: inserted.rows[0].request_id,
          status: inserted.rows[0].status,
          recipientAddress: body.recipientAddress,
          sponsorOrganizationReference: config.sponsorOrganizationReference,
          sponsorAgreementReference: config.sponsorAgreementReference,
          treasuryAddress,
          createdAt: inserted.rows[0].created_at,
          expiresAt: inserted.rows[0].approval_expires_at,
        },
        approvalMessage,
        requiredSponsorSignerAddresses: config.sponsorApproverAddresses,
        limitations: ['This signature approves only the exact recipient destination. Every payout still requires the separate per-transfer owner authorization, sponsor budget checks, Fireblocks policy, and independent chain verification.'],
      })
    } catch (error) {
      if (error?.code === '23505') return res.status(409).json({ success: false, error: 'recipient-approval-request-already-active' })
      return res.status(503).json({ success: false, error: 'recipient-approval-storage-unavailable' })
    }
  })

  router.get('/recipient-approval-requests/:requestId', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const requestId = req.params.requestId
    const origin = req.get('origin')
    if (!UUID_PATTERN.test(requestId || '') || !isConfiguredTreasuryApprovalOrigin(origin, env)) {
      return res.status(400).json({ success: false, error: 'invalid-recipient-approval-reference-or-origin' })
    }
    const config = configuration()
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      let result = await db.query(`SELECT * FROM trc20_token_clone.treasury_recipient_approval_requests WHERE request_id=$1`, [requestId])
      if (!result.rows.length) return res.status(404).json({ success: false, error: 'recipient-approval-request-not-found' })
      let row = result.rows[0]
      if (row.requester_origin !== origin) return res.status(403).json({ success: false, error: 'recipient-approval-origin-mismatch' })
      const current = now()
      const currentMs = current instanceof Date ? current.getTime() : Number(current)
      if (row.status === 'pending' && new Date(row.approval_expires_at).getTime() <= currentMs) {
        result = await db.query(`UPDATE trc20_token_clone.treasury_recipient_approval_requests
          SET status='expired', updated_at=now()
          WHERE request_id=$1 AND status='pending' RETURNING *`, [requestId])
        row = result.rows[0] || row
      }
      const expiryMs = new Date(row.approval_expires_at).getTime()
      const approvalMessage = row.status === 'pending' ? buildTreasuryRecipientApprovalMessage({
        requestId: row.request_id,
        sponsorOrganizationReference: row.sponsor_organization_reference,
        sponsorAgreementReference: row.sponsor_agreement_reference,
        treasuryAddress: row.treasury_address,
        recipientAddress: row.recipient_address,
        requesterAddress: row.requester_owner_address,
        requesterOrigin: row.requester_origin,
        reason: row.request_reason,
        expiresAt: expiryMs,
      }) : null
      const revocationMessage = row.status === 'approved' ? buildTreasuryRecipientRevocationMessage({
        requestId: row.request_id,
        sponsorOrganizationReference: row.sponsor_organization_reference,
        sponsorAgreementReference: row.sponsor_agreement_reference,
        treasuryAddress: row.treasury_address,
        recipientAddress: row.recipient_address,
        approvalMessageHash: row.approval_message_hash,
        requesterOrigin: row.requester_origin,
      }) : null
      return res.json({
        success: true,
        request: {
          requestId: row.request_id,
          status: row.status,
          recipientAddress: row.recipient_address,
          treasuryAddress: row.treasury_address,
          sponsorOrganizationReference: row.sponsor_organization_reference,
          sponsorAgreementReference: row.sponsor_agreement_reference,
          reason: row.request_reason,
          approverAddress: row.approver_address || null,
          approvedAt: row.approved_at || null,
          revokedAt: row.revoked_at || null,
          expiresAt: row.approval_expires_at,
        },
        approvalMessage,
        revocationMessage,
        sponsorApproverAddressesValid: config.sponsorApproverAddressesValid,
        requiredSponsorSignerAddresses: config.sponsorApproverAddresses,
        note: 'The sponsor signer must independently inspect this exact request. The owner console cannot approve a destination on the sponsor organization behalf.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'recipient-approval-lookup-unavailable' })
    }
  })

  router.post('/recipient-approval-requests/:requestId/approve', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const requestId = req.params.requestId
    const origin = req.get('origin')
    if (!UUID_PATTERN.test(requestId || '') || !isConfiguredTreasuryApprovalOrigin(origin, env)) {
      return res.status(400).json({ success: false, error: 'invalid-recipient-approval-reference-or-origin' })
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).length !== 1 || typeof body.signature !== 'string' || !OWNER_PAYOUT_SIGNATURE_PATTERN.test(body.signature)) {
      return res.status(400).json({ success: false, error: 'invalid-sponsor-approval-signature' })
    }
    const config = configuration()
    if (!config.sponsorAgreementScopeApproved || !config.sponsorApproverAddressesValid) {
      return res.status(503).json({ success: false, error: 'sponsor-recipient-approval-not-configured' })
    }
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    let client
    try {
      await ensureSchema(db)
      client = await db.connect()
      await client.query('BEGIN')
      const lookup = await client.query(`SELECT * FROM trc20_token_clone.treasury_recipient_approval_requests
        WHERE request_id=$1 FOR UPDATE`, [requestId])
      if (!lookup.rows.length) {
        await client.query('ROLLBACK')
        return res.status(404).json({ success: false, error: 'recipient-approval-request-not-found' })
      }
      const row = lookup.rows[0]
      const current = now()
      const currentMs = current instanceof Date ? current.getTime() : Number(current)
      if (row.requester_origin !== origin) {
        await client.query('ROLLBACK')
        return res.status(403).json({ success: false, error: 'recipient-approval-origin-mismatch' })
      }
      if (row.status !== 'pending') {
        await client.query('ROLLBACK')
        return res.status(409).json({ success: false, error: row.status === 'approved' ? 'recipient-already-approved' : 'recipient-approval-request-not-pending', status: row.status })
      }
      if (!Number.isSafeInteger(currentMs) || new Date(row.approval_expires_at).getTime() <= currentMs) {
        await client.query(`UPDATE trc20_token_clone.treasury_recipient_approval_requests
          SET status='expired', updated_at=now() WHERE request_id=$1 AND status='pending'`, [requestId])
        await client.query('COMMIT')
        return res.status(410).json({ success: false, error: 'recipient-approval-request-expired' })
      }
      const treasuryAddress = typeof env.TREASURY_ADDRESS === 'string' ? env.TREASURY_ADDRESS.trim() : ''
      if (!config.sponsorAgreementScopeApproved
        || row.sponsor_organization_reference !== config.sponsorOrganizationReference
        || row.sponsor_agreement_reference !== config.sponsorAgreementReference
        || row.treasury_address !== treasuryAddress
        || row.token_contract !== USDT_MAINNET) {
        await client.query('ROLLBACK')
        return res.status(409).json({ success: false, error: 'recipient-approval-sponsor-scope-changed' })
      }
      const approvalMessage = buildTreasuryRecipientApprovalMessage({
        requestId: row.request_id,
        sponsorOrganizationReference: row.sponsor_organization_reference,
        sponsorAgreementReference: row.sponsor_agreement_reference,
        treasuryAddress: row.treasury_address,
        recipientAddress: row.recipient_address,
        requesterAddress: row.requester_owner_address,
        requesterOrigin: row.requester_origin,
        reason: row.request_reason,
        expiresAt: new Date(row.approval_expires_at).getTime(),
      })
      const expectedHash = createHash('sha256').update(approvalMessage, 'utf8').digest('hex')
      if (expectedHash !== String(row.approval_message_hash).trim().toLowerCase()) {
        await client.query('ROLLBACK')
        return res.status(409).json({ success: false, error: 'recipient-approval-message-integrity-failed' })
      }
      const approverAddress = await recoverTreasurySponsorRecipientApprover(tronWebFactory(), {
        message: approvalMessage,
        signature: body.signature,
        allowedSignerAddresses: config.sponsorApproverAddresses,
      })
      if (!approverAddress) {
        await client.query('ROLLBACK')
        return res.status(403).json({ success: false, error: 'sponsor-recipient-approval-signature-invalid' })
      }
      const updated = await client.query(`UPDATE trc20_token_clone.treasury_recipient_approval_requests
        SET status='approved', approver_address=$2, approval_signature=$3, approved_at=now(), updated_at=now()
        WHERE request_id=$1 AND status='pending' RETURNING request_id, status, approver_address, approved_at`,
      [requestId, approverAddress, body.signature])
      await client.query('COMMIT')
      return res.json({ success: true, request: updated.rows[0], note: 'The sponsor approval is recorded for this exact destination and sponsor agreement. It does not execute a payout.' })
    } catch {
      try { await client?.query('ROLLBACK') } catch {}
      return res.status(503).json({ success: false, error: 'recipient-approval-submit-unavailable' })
    } finally {
      client?.release()
    }
  })

  router.post('/recipient-approval-requests/:requestId/revoke', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const requestId = req.params.requestId
    const origin = req.get('origin')
    if (!UUID_PATTERN.test(requestId || '') || !isConfiguredTreasuryApprovalOrigin(origin, env)) {
      return res.status(400).json({ success: false, error: 'invalid-recipient-approval-reference-or-origin' })
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).length !== 1 || typeof body.signature !== 'string' || !OWNER_PAYOUT_SIGNATURE_PATTERN.test(body.signature)) {
      return res.status(400).json({ success: false, error: 'invalid-sponsor-revocation-signature' })
    }
    const config = configuration()
    if (!config.sponsorAgreementScopeApproved || !config.sponsorApproverAddressesValid) {
      return res.status(503).json({ success: false, error: 'sponsor-recipient-approval-not-configured' })
    }
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    let client
    try {
      await ensureSchema(db)
      client = await db.connect()
      await client.query('BEGIN')
      const lookup = await client.query(`SELECT * FROM trc20_token_clone.treasury_recipient_approval_requests
        WHERE request_id=$1 FOR UPDATE`, [requestId])
      if (!lookup.rows.length) {
        await client.query('ROLLBACK')
        return res.status(404).json({ success: false, error: 'recipient-approval-request-not-found' })
      }
      const row = lookup.rows[0]
      if (row.requester_origin !== origin) {
        await client.query('ROLLBACK')
        return res.status(403).json({ success: false, error: 'recipient-approval-origin-mismatch' })
      }
      if (row.status !== 'approved') {
        await client.query('ROLLBACK')
        return res.status(409).json({ success: false, error: 'recipient-not-currently-approved', status: row.status })
      }
      const treasuryAddress = typeof env.TREASURY_ADDRESS === 'string' ? env.TREASURY_ADDRESS.trim() : ''
      if (row.sponsor_organization_reference !== config.sponsorOrganizationReference
        || row.sponsor_agreement_reference !== config.sponsorAgreementReference
        || row.treasury_address !== treasuryAddress
        || row.token_contract !== USDT_MAINNET) {
        await client.query('ROLLBACK')
        return res.status(409).json({ success: false, error: 'recipient-approval-sponsor-scope-changed' })
      }
      const revocationMessage = buildTreasuryRecipientRevocationMessage({
        requestId: row.request_id,
        sponsorOrganizationReference: row.sponsor_organization_reference,
        sponsorAgreementReference: row.sponsor_agreement_reference,
        treasuryAddress: row.treasury_address,
        recipientAddress: row.recipient_address,
        approvalMessageHash: String(row.approval_message_hash).trim(),
        requesterOrigin: row.requester_origin,
      })
      const approverAddress = await recoverTreasurySponsorRecipientApprover(tronWebFactory(), {
        message: revocationMessage,
        signature: body.signature,
        allowedSignerAddresses: config.sponsorApproverAddresses,
      })
      if (!approverAddress) {
        await client.query('ROLLBACK')
        return res.status(403).json({ success: false, error: 'sponsor-recipient-revocation-signature-invalid' })
      }
      const revocationMessageHash = createHash('sha256').update(revocationMessage, 'utf8').digest('hex')
      const updated = await client.query(`UPDATE trc20_token_clone.treasury_recipient_approval_requests
        SET status='revoked', revoked_by=$2, revocation_signature=$3, revocation_message_hash=$4,
            revoked_at=now(), updated_at=now()
        WHERE request_id=$1 AND status='approved' RETURNING request_id, status, revoked_by, revoked_at`,
      [requestId, approverAddress, body.signature, revocationMessageHash])
      await client.query('COMMIT')
      return res.json({ success: true, request: updated.rows[0], note: 'The sponsor-signed destination approval is revoked. Future withdrawals to this recipient are blocked unless the sponsor approves a new request.' })
    } catch {
      try { await client?.query('ROLLBACK') } catch {}
      return res.status(503).json({ success: false, error: 'recipient-approval-revocation-unavailable' })
    } finally {
      client?.release()
    }
  })

  router.get('/withdrawals/release-authorization/message', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const config = configuration()
    if (!config.configurationComplete || !config.featureFlagEnabled) {
      return res.status(503).json({
        success: false,
        error: 'treasury-release-preconditions-incomplete',
        missing: config.missing,
      })
    }
    try {
      const clock = now()
      const nowMs = clock instanceof Date ? clock.getTime() : Number(clock)
      const message = buildTreasuryRealValueReleaseMessage(env, { now: nowMs })
      return res.json({
        success: true,
        message,
        messageHash: createHash('sha256').update(message, 'utf8').digest('hex'),
        releaseReference: env.TREASURY_REAL_VALUE_RELEASE_REFERENCE.trim(),
        expiresAt: Number(env.TREASURY_REAL_VALUE_RELEASE_EXPIRES_AT),
        requiredSponsorSignerAddresses: config.sponsorApproverAddresses,
        note: 'A configured sponsor signer must inspect this complete message and sign it in the sponsor organization’s controlled wallet. This signature enables only the exact release scope; it does not send USDT. The application never receives a private key.',
      })
    } catch (error) {
      return res.status(503).json({
        success: false,
        error: 'treasury-release-message-unavailable',
        reason: error instanceof Error ? error.message : 'release-configuration-invalid',
      })
    }
  })

  router.get('/withdrawals/release-authorization/revocation-message', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const origin = req.get('origin')
    if (!isConfiguredTreasuryApprovalOrigin(origin, env)) {
      return res.status(403).json({ success: false, error: 'release-approval-origin-not-allowed' })
    }
    const config = configuration()
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'release-authorization-database-not-configured' })
    try {
      await ensureSchema(db)
      const result = await db.query(`SELECT *
        FROM trc20_token_clone.treasury_real_value_release_authorizations
        WHERE release_reference=$1 AND sponsor_organization_reference=$2
          AND sponsor_agreement_reference=$3 AND treasury_address=$4
          AND status='active' AND release_expires_at > now()
        ORDER BY created_at DESC LIMIT 1`, [
        typeof env.TREASURY_REAL_VALUE_RELEASE_REFERENCE === 'string' ? env.TREASURY_REAL_VALUE_RELEASE_REFERENCE.trim() : '',
        config.sponsorOrganizationReference,
        config.sponsorAgreementReference,
        typeof env.TREASURY_ADDRESS === 'string' ? env.TREASURY_ADDRESS.trim() : '',
      ])
      const row = result.rows[0]
      if (!row) return res.status(404).json({ success: false, error: 'active-sponsor-release-not-found' })
      if (row.requester_origin !== origin) {
        return res.status(403).json({ success: false, error: 'release-approval-origin-mismatch' })
      }
      const message = buildTreasuryRealValueReleaseRevocationMessage({
        releaseReference: row.release_reference,
        messageHash: String(row.release_message_hash).trim(),
        sponsorOrganizationReference: row.sponsor_organization_reference,
        sponsorAgreementReference: row.sponsor_agreement_reference,
        treasuryAddress: row.treasury_address,
        requesterOrigin: row.requester_origin,
      })
      return res.json({
        success: true,
        message,
        messageHash: createHash('sha256').update(message, 'utf8').digest('hex'),
        releaseReference: row.release_reference,
        originalMessageHash: String(row.release_message_hash).trim(),
        expiresAt: row.release_expires_at,
        sponsorSignerAddress: row.sponsor_signer_address,
      })
    } catch {
      return res.status(503).json({ success: false, error: 'sponsor-release-revocation-message-unavailable' })
    }
  })

  router.post('/withdrawals/release-authorization/signature', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    if (env.TREASURY_REAL_VALUE_EXECUTION_ENABLED !== 'true') {
      return res.status(403).json({ success: false, error: 'owner-release-switch-must-be-explicitly-enabled-first' })
    }
    const config = configuration()
    if (!config.enabled || !config.sponsorAgreementScopeApproved || !config.sponsorApproverAddressesValid) {
      return res.status(503).json({ success: false, error: 'treasury-release-preconditions-incomplete', missing: config.missing })
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).length !== 1 || typeof body.signature !== 'string'
      || !OWNER_PAYOUT_SIGNATURE_PATTERN.test(body.signature)) {
      return res.status(400).json({ success: false, error: 'invalid-sponsor-release-signature' })
    }
    if (!isConfiguredTreasuryApprovalOrigin(req.get('origin'), env)) {
      return res.status(403).json({ success: false, error: 'release-approval-origin-not-allowed' })
    }
    const clock = now()
    const nowMs = clock instanceof Date ? clock.getTime() : Number(clock)
    let message
    try {
      message = buildTreasuryRealValueReleaseMessage(env, { now: nowMs })
    } catch {
      return res.status(503).json({ success: false, error: 'treasury-release-message-invalid' })
    }
    const sponsorSigner = await recoverTreasurySponsorRecipientApprover(tronWebFactory(), {
      message,
      signature: body.signature,
      allowedSignerAddresses: config.sponsorApproverAddresses,
    })
    if (!sponsorSigner) {
      return res.status(403).json({ success: false, error: 'sponsor-release-signature-not-from-authorized-signer' })
    }
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'release-authorization-database-not-configured' })
    let client
    try {
      await ensureSchema(db)
      client = await db.connect()
      await client.query('BEGIN')
      const releaseReference = env.TREASURY_REAL_VALUE_RELEASE_REFERENCE.trim()
      const messageHash = createHash('sha256').update(message, 'utf8').digest('hex')
      const existing = await client.query(`SELECT release_authorization_id, sponsor_signer_address
        FROM trc20_token_clone.treasury_real_value_release_authorizations
        WHERE release_reference=$1 AND release_message_hash=$2 AND status='active'
        FOR UPDATE`, [releaseReference, messageHash])
      if (existing.rows.length) {
        await client.query('COMMIT')
        return res.json({
          success: true,
          alreadyAuthorized: true,
          releaseAuthorization: {
            releaseReference,
            messageHash,
            sponsorSignerAddress: existing.rows[0].sponsor_signer_address,
            expiresAt: env.TREASURY_REAL_VALUE_RELEASE_EXPIRES_AT,
          },
          note: 'This exact sponsor release scope was already recorded. No transfer was initiated.',
        })
      }
      await client.query(`UPDATE trc20_token_clone.treasury_real_value_release_authorizations
        SET status='superseded', updated_at=now()
        WHERE release_reference=$1 AND status='active'`, [releaseReference])
      const inserted = await client.query(`INSERT INTO trc20_token_clone.treasury_real_value_release_authorizations
        (release_authorization_id, release_reference, sponsor_organization_reference,
         sponsor_agreement_reference, treasury_address, requester_origin,
         release_message, release_message_hash, release_expires_at,
         sponsor_signer_address, sponsor_signature, status, created_by_owner_address)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9 / 1000.0),$10,$11,'active',$12)
        RETURNING release_authorization_id, release_reference, release_message_hash,
                  release_expires_at, sponsor_signer_address, status, created_at`, [
        randomUUID(), releaseReference, config.sponsorOrganizationReference,
        config.sponsorAgreementReference, env.TREASURY_ADDRESS.trim(), req.get('origin'),
        message, messageHash, Number(env.TREASURY_REAL_VALUE_RELEASE_EXPIRES_AT),
        sponsorSigner, body.signature, auth.ownerAddress,
      ])
      await client.query('COMMIT')
      return res.status(201).json({
        success: true,
        releaseAuthorization: inserted.rows[0],
        note: 'Sponsor release approval stored for this exact current configuration. Actual withdrawals remain subject to live readiness, owner per-transfer signature, Fireblocks policy and chain receipt verification.',
      })
    } catch {
      try { await client?.query('ROLLBACK') } catch {}
      return res.status(503).json({ success: false, error: 'sponsor-release-authorization-storage-unavailable' })
    } finally {
      client?.release()
    }
  })

  router.post('/withdrawals/release-authorization/revoke', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const origin = req.get('origin')
    if (!isConfiguredTreasuryApprovalOrigin(origin, env)) {
      return res.status(403).json({ success: false, error: 'release-approval-origin-not-allowed' })
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).length !== 1 || typeof body.signature !== 'string'
      || !OWNER_PAYOUT_SIGNATURE_PATTERN.test(body.signature)) {
      return res.status(400).json({ success: false, error: 'invalid-sponsor-release-revocation-signature' })
    }
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'release-authorization-database-not-configured' })
    let client
    try {
      await ensureSchema(db)
      client = await db.connect()
      await client.query('BEGIN')
      const config = configuration()
      const lookup = await client.query(`SELECT * FROM trc20_token_clone.treasury_real_value_release_authorizations
        WHERE release_reference=$1 AND sponsor_organization_reference=$2
          AND sponsor_agreement_reference=$3 AND treasury_address=$4
          AND status='active'
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [
        typeof env.TREASURY_REAL_VALUE_RELEASE_REFERENCE === 'string' ? env.TREASURY_REAL_VALUE_RELEASE_REFERENCE.trim() : '',
        config.sponsorOrganizationReference, config.sponsorAgreementReference,
        typeof env.TREASURY_ADDRESS === 'string' ? env.TREASURY_ADDRESS.trim() : '',
      ])
      const row = lookup.rows[0]
      if (!row) {
        await client.query('ROLLBACK')
        return res.status(404).json({ success: false, error: 'active-sponsor-release-not-found' })
      }
      const revocationMessage = buildTreasuryRealValueReleaseRevocationMessage({
        releaseReference: row.release_reference,
        messageHash: String(row.release_message_hash).trim(),
        sponsorOrganizationReference: row.sponsor_organization_reference,
        sponsorAgreementReference: row.sponsor_agreement_reference,
        treasuryAddress: row.treasury_address,
        requesterOrigin: row.requester_origin,
      })
      const sponsorSigner = await recoverTreasurySponsorRecipientApprover(tronWebFactory(), {
        message: revocationMessage,
        signature: body.signature,
        allowedSignerAddresses: config.sponsorApproverAddresses,
      })
      if (!sponsorSigner) {
        await client.query('ROLLBACK')
        return res.status(403).json({ success: false, error: 'sponsor-release-revocation-signature-invalid' })
      }
      const revocationHash = createHash('sha256').update(revocationMessage, 'utf8').digest('hex')
      const updated = await client.query(`UPDATE trc20_token_clone.treasury_real_value_release_authorizations
        SET status='revoked', revocation_message_hash=$2, revoked_by=$3,
            revocation_signature=$4, revoked_at=now(), updated_at=now()
        WHERE release_authorization_id=$1 AND status='active'
        RETURNING release_authorization_id, release_reference, status, revoked_by, revoked_at`,
      [row.release_authorization_id, revocationHash, sponsorSigner, body.signature])
      await client.query('COMMIT')
      return res.json({
        success: true,
        releaseAuthorization: updated.rows[0],
        note: 'Sponsor release authorization revoked. New USDT submissions are blocked; any request already reserved or submitted must be reconciled separately.',
      })
    } catch {
      try { await client?.query('ROLLBACK') } catch {}
      return res.status(503).json({ success: false, error: 'sponsor-release-revocation-unavailable' })
    } finally {
      client?.release()
    }
  })

  router.get('/withdrawals/readiness', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    res.setHeader('Pragma', 'no-cache')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const config = configuration()
    const db = getPool(env)
    let databaseReady = false
    if (db) { try { await ensureSchema(db); await db.query('SELECT 1'); databaseReady = true } catch {} }
    const treasuryAddress = ADDRESS_PATTERN.test(env.TREASURY_ADDRESS || '') ? env.TREASURY_ADDRESS.trim() : null
    const outboundHistory = databaseReady && treasuryAddress
      ? await getFireblocksOutboundHistoryStatus({ env, treasuryAddress })
      : { verified: false, reason: 'fireblocks-vault-outbound-history-not-reconciled' }
    let snapshot = { ok: false, reason: 'treasury-address-not-configured' }
    // Read-only readiness must work while payouts are deliberately disabled.
    // Probe Fireblocks and public Mainnet balances when provider credentials and
    // the configured treasury address are present; this never submits a transfer.
    if (config.providerConfigured && treasuryAddress) {
      snapshot = await readManagedTreasurySnapshot(treasuryAddress)
    }
    const blockers = []
    if (!outboundHistory.verified) blockers.push('fireblocks-vault-outbound-history-not-reconciled')
    let pendingUsdtCount = '0'
    let pendingTrxCount = '0'
    let requiredFeeReserveSun = null
    let feeReserveCovered = false
    let sponsorPrincipalBudget = null
    let sponsorPrincipalBudgetCapConsistent = false
    let applicationCommittedBaseUnits = '0'
    let externalOutboundUsdtBaseUnits = '0'
    if (!config.configurationComplete) blockers.push('managed-signer-configuration-incomplete')
    if (!config.featureFlagEnabled) blockers.push('usdt-payout-feature-disabled')
    if (!databaseReady) blockers.push('database-not-ready')
    if (!treasuryAddress) blockers.push('treasury-address-not-configured')
    if (!snapshot.ok) blockers.push(snapshot.reason || 'provider-funding-unverified')
    if (databaseReady && treasuryAddress) {
      try {
        const [pendingUsdt, pendingTrx, sponsorBudgetUsage] = await Promise.all([
          db.query(`SELECT COUNT(*)::text AS count
            FROM trc20_token_clone.treasury_withdrawal_requests
            WHERE treasury_address=$1 AND status IN ('broadcasting','provider-pending','broadcast-accepted','broadcast-unknown')`, [treasuryAddress]),
          db.query(`SELECT COUNT(*)::text AS count
            FROM trc20_token_clone.treasury_trx_withdrawal_requests
            WHERE treasury_address=$1 AND status IN ('broadcasting','provider-pending','broadcast-accepted','broadcast-unknown')`, [treasuryAddress]),
          db.query(`SELECT COALESCE(SUM(amount_base_units),0)::text AS amount,
                   MIN(sponsor_agreement_budget_base_units)::text AS min_budget_cap,
                   MAX(sponsor_agreement_budget_base_units)::text AS max_budget_cap,
                   COUNT(*) FILTER (
                     WHERE sponsor_organization_reference IS NULL
                        OR sponsor_agreement_reference IS NULL
                        OR sponsor_agreement_budget_base_units IS NULL
                   )::text AS unpinned_agreement_rows
            FROM trc20_token_clone.treasury_withdrawal_requests
            WHERE treasury_address=$1
              AND (
                (sponsor_organization_reference=$2 AND sponsor_agreement_reference=$3)
                OR sponsor_organization_reference IS NULL
                OR sponsor_agreement_reference IS NULL
              )
              AND status <> 'rejected'`,
          [treasuryAddress, config.sponsorOrganizationReference, config.sponsorAgreementReference]),
        ])
        pendingUsdtCount = String(pendingUsdt.rows[0]?.count || '0')
        pendingTrxCount = String(pendingTrx.rows[0]?.count || '0')
        sponsorPrincipalBudgetCapConsistent = sponsorPrincipalBudgetCapMatches(config.sponsorTotalBudgetBaseUnits, {
          minimumStoredBudgetBaseUnits: sponsorBudgetUsage.rows[0]?.min_budget_cap ?? null,
          maximumStoredBudgetBaseUnits: sponsorBudgetUsage.rows[0]?.max_budget_cap ?? null,
          unpinnedAgreementRows: String(sponsorBudgetUsage.rows[0]?.unpinned_agreement_rows || '0'),
        })
        applicationCommittedBaseUnits = String(sponsorBudgetUsage.rows[0]?.amount || '0')
        externalOutboundUsdtBaseUnits = outboundHistory.verified
          ? String(outboundHistory.externalUsdtBaseUnits || '0')
          : '0'
        const committedSponsorPrincipalBaseUnits = (
          BigInt(applicationCommittedBaseUnits) + BigInt(externalOutboundUsdtBaseUnits)
        ).toString()
        // Never report apparent remaining sponsor principal from app rows alone.
        // If external vault history is missing/stale, the unobserved manual outflows
        // could consume the remaining commitment; keep this budget unverified.
        if (outboundHistory.verified) {
          sponsorPrincipalBudget = calculateSponsorPrincipalBudgetState(
            config.sponsorTotalBudgetBaseUnits,
            committedSponsorPrincipalBaseUnits,
          )
        }
        if (!sponsorPrincipalBudgetCapConsistent) blockers.push('sponsor-principal-agreement-budget-cap-changed-or-legacy-rows-unpinned')
        if (!sponsorPrincipalBudget || BigInt(sponsorPrincipalBudget.remainingBaseUnits) <= 0n) {
          blockers.push('sponsor-principal-agreement-budget-exhausted-or-unavailable')
        }
        requiredFeeReserveSun = requiredTreasuryFeeReserveSun(env.TREASURY_FEE_LIMIT_SUN, pendingUsdtCount, pendingTrxCount)
        feeReserveCovered = snapshot.ok && requiredFeeReserveSun !== null
          && treasuryFeeReserveCovered(snapshot.treasuryTrxBalanceSun, snapshot.providerAvailableTrxBaseUnits, requiredFeeReserveSun)
        if (requiredFeeReserveSun === null) blockers.push('treasury-fee-reserve-calculation-invalid')
        else if (snapshot.ok && !feeReserveCovered) blockers.push('treasury-trx-fee-reservations-exceed-available-balance')
      } catch {
        databaseReady = false
        blockers.push('fee-reservation-ledger-unavailable')
      }
    }
    if (snapshot.ok) {
      if (BigInt(snapshot.spendableUsdtBaseUnits) <= 0n) blockers.push('treasury-usdt-balance-zero-or-unavailable')
      if (!snapshot.networkFeeCapCovered) blockers.push('treasury-trx-below-fee-cap')
    }
    if (!databaseReady && !blockers.includes('database-not-ready')) blockers.push('database-not-ready')
    const preflightChecksPassed = blockers.length === 0
    const releaseAuthorization = await currentRealValueReleaseAuthorization()
    const payoutExecution = treasuryPayoutExecutionState(preflightChecksPassed, releaseAuthorization.authorized)
    return res.json({
      success: true, network: 'mainnet', asset: 'USDT', tokenContract: USDT_MAINNET,
      ...payoutExecution,
      preflightChecksPassed,
      releaseAuthorization: {
        authorized: releaseAuthorization.authorized,
        reason: releaseAuthorization.reason,
        signerAddress: releaseAuthorization.signerAddress || null,
        releaseReference: releaseAuthorization.releaseReference || null,
        expiresAt: releaseAuthorization.expiresAt || null,
        messageHash: releaseAuthorization.messageHash || null,
      },
      configuration: {
        enabled: config.enabled,
        configurationComplete: config.configurationComplete,
        featureFlagEnabled: config.featureFlagEnabled,
        sponsorAgreementScopeApproved: config.sponsorAgreementScopeApproved,
        recipientAllowlistValid: config.recipientAllowlistValid,
        recipientAllowlistCount: config.recipientAllowlistCount,
        sponsorApproverAddressesValid: config.sponsorApproverAddressesValid,
        sponsorApproverCount: config.sponsorApproverCount,
        recipientApprovalMode: config.recipientApprovalMode,
        missing: config.missing,
        signerMode: config.signerMode,
        providerConfigured: config.providerConfigured,
      },
      databaseReady, treasuryAddress,
      externalOutboundHistory: {
        verified: outboundHistory.verified === true,
        status: outboundHistory.status || null,
        reason: outboundHistory.reason || null,
        checkedAt: outboundHistory.checkedAt || null,
        ageMs: outboundHistory.ageMs ?? null,
        transactionCount: outboundHistory.transactionCount || '0',
        externalUsdtBaseUnits: outboundHistory.verified ? String(outboundHistory.externalUsdtBaseUnits || '0') : null,
        externalTrxBaseUnits: outboundHistory.verified ? String(outboundHistory.externalTrxBaseUnits || '0') : null,
        networkFeeTrxBaseUnits: outboundHistory.verified ? String(outboundHistory.networkFeeTrxBaseUnits || '0') : null,
        reconciliationDigest: outboundHistory.verified ? outboundHistory.reconciliationDigest || null : null,
      },
      sponsorPrincipalBudget: sponsorPrincipalBudget ? {
        organizationReference: config.sponsorOrganizationReference,
        agreementReference: config.sponsorAgreementReference,
        totalBaseUnits: sponsorPrincipalBudget.totalBudgetBaseUnits,
        usedAndReservedBaseUnits: sponsorPrincipalBudget.usedBaseUnits,
        applicationCommittedBaseUnits: typeof applicationCommittedBaseUnits === 'string' ? applicationCommittedBaseUnits : '0',
        externalOutboundUsdtBaseUnits: outboundHistory.verified ? String(outboundHistory.externalUsdtBaseUnits || '0') : null,
        remainingBaseUnits: sponsorPrincipalBudget.remainingBaseUnits,
        withinBudget: sponsorPrincipalBudget.withinBudget,
        commitmentCapConsistent: sponsorPrincipalBudgetCapConsistent,
      } : {
        organizationReference: config.sponsorOrganizationReference,
        agreementReference: config.sponsorAgreementReference,
        status: 'not-verified',
      },
      ...(snapshot.ok ? {
        providerAssetId: snapshot.providerAssetId,
        providerAvailableUsdtBaseUnits: snapshot.providerAvailableBaseUnits,
        treasuryUsdtBalanceBaseUnits: snapshot.treasuryUsdtBalanceBaseUnits,
        spendableUsdtBaseUnits: snapshot.spendableUsdtBaseUnits,
        treasuryTrxBalanceSun: snapshot.treasuryTrxBalanceSun,
        providerAvailableTrxBaseUnits: snapshot.providerAvailableTrxBaseUnits,
        treasuryFeeLimitSun: snapshot.treasuryFeeLimitSun,
        requiredFeeReserveSun,
        pendingUsdtPayoutCount: pendingUsdtCount,
        pendingTrxPayoutCount: pendingTrxCount,
        feeReserveCovered,
        networkFeeCapCovered: snapshot.networkFeeCapCovered,
        providerAssetIdentityVerified: snapshot.contractMetadataVerified,
        providerVaultAddressVerified: snapshot.vaultAddressVerified,
        providerVaultAccountVerified: snapshot.vaultAccountVerified,
        providerUsdtAssetActivated: snapshot.usdtAssetActivated,
        providerTrxAssetActivated: snapshot.trxAssetActivated,
        nativeTrxAssetIdentityVerified: snapshot.nativeTrxAssetIdentityVerified,
        nativeTrxVaultAddressVerified: snapshot.nativeTrxVaultAddressVerified,
      } : {}),
      payoutBlockers: [...new Set([...blockers, ...(payoutExecution.executionBlocker ? [payoutExecution.executionBlocker] : [])])],
      limitations: [
        'Transfers are initiated through the configured managed Fireblocks vault; blockchain signing keys are not loaded by the API.',
        'Provider transaction acceptance is not proof of on-chain confirmation; verify the successful solidified receipt and exact official-USDT Transfer event.',
        'The treasury must have genuine USDT and sufficient TRX for the configured fee cap unless a separately verified fee sponsor is integrated.',
        'An exchange deposit may require additional confirmations and is controlled by the receiving exchange.',
      ],
    })
  })

  router.post('/withdrawals', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    if (REAL_VALUE_PAYOUT_EXECUTION_DISABLED) {
      return res.status(503).json({
        success: false,
        error: 'real-value-payout-execution-disabled-in-this-build',
        submissionEnabled: false,
      })
    }
    const config = configuration()
    if (!config.enabled) return res.status(503).json({ success: false, error: 'treasury-withdrawals-disabled', missing: config.missing })
    const historyGate = await getFireblocksOutboundHistoryStatus({ env })
    if (!historyGate.verified) {
      return res.status(409).json({
        success: false,
        error: 'fireblocks-vault-outbound-history-not-reconciled',
        submissionEnabled: false,
      })
    }
    const releaseAuthorization = await currentRealValueReleaseAuthorization()
    if (!releaseAuthorization.authorized) {
      return res.status(503).json({
        success: false,
        error: 'sponsor-real-value-release-authorization-required',
        reason: releaseAuthorization.reason,
        submissionEnabled: false,
      })
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).some((key) => !['recipientAddress', 'amountUsdt', 'idempotencyKey', 'ownerAuthorizationSignature', 'authorizationExpiresAt'].includes(key))
      || !ADDRESS_PATTERN.test(body.recipientAddress || '')
      || !IDEMPOTENCY_PATTERN.test(body.idempotencyKey || '')
      || typeof body.amountUsdt !== 'string'
      || typeof body.ownerAuthorizationSignature !== 'string'
      || !OWNER_PAYOUT_SIGNATURE_PATTERN.test(body.ownerAuthorizationSignature)
      || !Number.isSafeInteger(body.authorizationExpiresAt)) {
      return res.status(400).json({ success: false, error: 'invalid-withdrawal-request' })
    }
    const clockValue = now()
    const currentTimeMs = clockValue instanceof Date ? clockValue.getTime() : Number(clockValue)
    if (!isTreasuryAuthorizationExpiryValid(body.authorizationExpiresAt, currentTimeMs, OWNER_PAYOUT_AUTHORIZATION_MAX_FUTURE_MS)) {
      return res.status(401).json({ success: false, error: 'owner-payout-authorization-expired-or-outside-window' })
    }
    const amount = parsePositiveDecimal(body.amountUsdt)
    const maxPayout = readLimit(env.TREASURY_MAX_PAYOUT_USDT)
    const dailyLimit = readLimit(env.TREASURY_DAILY_LIMIT_USDT)
    if (!amount || !maxPayout || !dailyLimit || amount > maxPayout || amount > dailyLimit) {
      return res.status(400).json({ success: false, error: 'amount-outside-configured-limits' })
    }
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const treasuryAddress = typeof env.TREASURY_ADDRESS === 'string' ? env.TREASURY_ADDRESS.trim() : ''
      const tronWeb = tronWebFactory()
      const staticallyApproved = isTreasuryRecipientAllowed(body.recipientAddress, config.allowedRecipientAddresses)
      if (!tronWeb.isAddress(body.recipientAddress)
        || !ADDRESS_PATTERN.test(treasuryAddress)
        || !tronWeb.isAddress(treasuryAddress)
        || treasuryAddress === body.recipientAddress) {
        return res.status(503).json({ success: false, error: 'invalid-treasury-or-recipient' })
      }
      const authorizationMessage = buildTreasuryWithdrawalAuthorizationMessage({
        origin: req.get('origin'),
        ownerAddress: auth.ownerAddress,
        treasuryAddress,
        recipientAddress: body.recipientAddress,
        amountBaseUnits: amount.toString(),
        idempotencyKey: body.idempotencyKey,
        authorizationExpiresAt: body.authorizationExpiresAt,
      })
      const ownerAuthorizedThisPayout = await verifyTreasuryOwnerPayoutSignature(tronWeb, {
        message: authorizationMessage,
        signature: body.ownerAuthorizationSignature,
        expectedOwnerAddress: auth.ownerAddress,
      })
      if (!ownerAuthorizedThisPayout) {
        return res.status(403).json({ success: false, error: 'owner-payout-signature-invalid' })
      }
      const configuredFeeLimit = Number(env.TREASURY_FEE_LIMIT_SUN)
      const initialSnapshot = await readManagedTreasurySnapshot(treasuryAddress)
      if (!initialSnapshot.ok) return res.status(503).json({ success: false, error: 'treasury-provider-funding-not-verified', reason: initialSnapshot.reason, submissionEnabled: false })
      if (!initialSnapshot.networkFeeCapCovered) return res.status(409).json({ success: false, error: 'treasury-trx-insufficient-for-fee-cap', treasuryTrxBalanceSun: initialSnapshot.treasuryTrxBalanceSun, requiredFeeLimitSun: String(configuredFeeLimit), submissionEnabled: false })
      const chainContract = await tronWeb.contract(ABI).at(USDT_MAINNET)

      const client = await db.connect()
      let reservation
      let sponsorRecipientApprovalRequestId = null
      try {
        await client.query('BEGIN')
        await client.query("SELECT pg_advisory_xact_lock(hashtext('tron-token-studio-treasury-withdrawals-mainnet'))")
        const existing = await client.query('SELECT * FROM trc20_token_clone.treasury_withdrawal_requests WHERE idempotency_key = $1 FOR UPDATE', [body.idempotencyKey])
        if (existing.rows.length) {
          const prior = existing.rows[0]
          await client.query('COMMIT')
          if (!matchesTreasuryWithdrawalRequest(prior, {
            ownerAddress: auth.ownerAddress,
            treasuryAddress,
            recipientAddress: body.recipientAddress,
            amountBaseUnits: amount.toString(),
            sponsorOrganizationReference: config.sponsorOrganizationReference,
            sponsorAgreementReference: config.sponsorAgreementReference,
            sponsorAgreementBudgetBaseUnits: config.sponsorTotalBudgetBaseUnits,
          })) {
            return res.status(409).json({
              success: false,
              error: 'idempotency-key-conflict',
              message: 'This idempotency key is already bound to a different owner, recipient, treasury, or amount. No second transfer was broadcast.',
            })
          }
          return res.status(200).json({ success: true, duplicate: true, withdrawal: safeStatus(prior), note: 'Matching request returned; no second transfer was broadcast.' })
        }

        // Keep the sponsor release row locked through the principal reservation.
        // Sponsor release revocation takes FOR UPDATE and therefore cannot race
        // between release verification and reserving this new payout.
        const transactionalRelease = await lockCurrentRealValueReleaseAuthorization(client)
        if (!transactionalRelease.authorized) {
          await client.query('ROLLBACK')
          return res.status(503).json({
            success: false,
            error: 'sponsor-real-value-release-authorization-required',
            reason: transactionalRelease.reason,
            transactionSubmitted: false,
          })
        }

        // Lock the signed recipient approval in the same transaction as the payout reservation.
        // Sponsor recipient revocation takes FOR UPDATE on that row and therefore cannot race
        // between destination verification and principal reservation.
        if (!staticallyApproved) {
          if (!config.sponsorApproverAddressesValid) {
            await client.query('ROLLBACK')
            return res.status(403).json({ success: false, error: 'treasury-recipient-not-allowlisted' })
          }
          const approved = await client.query(`SELECT *
            FROM trc20_token_clone.treasury_recipient_approval_requests
            WHERE sponsor_organization_reference=$1 AND sponsor_agreement_reference=$2
              AND treasury_address=$3 AND recipient_address=$4 AND token_contract=$5
              AND status='approved' AND approver_address = ANY($6::text[])
            ORDER BY approved_at DESC LIMIT 1 FOR SHARE`, [
            config.sponsorOrganizationReference, config.sponsorAgreementReference,
            treasuryAddress, body.recipientAddress, USDT_MAINNET, config.sponsorApproverAddresses,
          ])
          const approvalRow = approved.rows[0]
          const sponsorSignedApproval = await verifyTreasurySponsorRecipientApproval(tronWeb, approvalRow, {
            allowedSignerAddresses: config.sponsorApproverAddresses,
          })
          if (!sponsorSignedApproval) {
            await client.query('ROLLBACK')
            return res.status(403).json({
              success: false,
              error: 'treasury-recipient-not-allowlisted',
              message: 'The destination has no active cryptographically verified sponsor-signed approval for this exact organization, agreement, treasury and Mainnet USDT contract. No withdrawal reservation or Fireblocks transfer was created.',
            })
          }
          sponsorRecipientApprovalRequestId = approvalRow.request_id
        }

        // Re-read the treasury's actual native TRX before reserving principal.
        // This path conservatively requires the full configured fee cap to be
        // available, rather than assuming an external gas sponsor will cover it.
        let nativeBalanceSun = String(await tronWeb.trx.getBalance(treasuryAddress))
        if (!treasuryFeeCapCovered(nativeBalanceSun, configuredFeeLimit)) {
          await client.query('ROLLBACK')
          return res.status(409).json({
            success: false,
            error: 'treasury-trx-insufficient-for-fee-cap',
            treasuryTrxBalanceSun: /^(0|[1-9][0-9]{0,20})$/.test(nativeBalanceSun) ? nativeBalanceSun : null,
            requiredFeeLimitSun: String(configuredFeeLimit),
            message: 'The treasury must hold enough real TRX to cover the configured fee cap before the payout is reserved. No USDT was sent.',
          })
        }

        // Read current chain balance while the database advisory lock serializes
        // treasury requests, then subtract all unresolved prior reservations.
        // This conservatively avoids accepting simultaneous payouts against the
        // same on-chain balance. Unknown broadcasts remain reserved until reconciled.
        const balanceValue = await chainContract.balanceOf(treasuryAddress).call()
        const balance = BigInt(String(balanceValue))
        const unsettled = await client.query(`
          SELECT COALESCE(SUM(amount_base_units), 0)::text AS amount,
                 COUNT(*)::text AS count
            FROM trc20_token_clone.treasury_withdrawal_requests
           WHERE treasury_address = $1
             AND status IN ('broadcasting','provider-pending','broadcast-accepted','broadcast-unknown')
        `, [treasuryAddress])
        const reservedBaseUnits = BigInt(unsettled.rows[0]?.amount || '0')
        const providerSnapshot = await readManagedTreasurySnapshot(treasuryAddress)
        if (!providerSnapshot.ok || !providerSnapshot.networkFeeCapCovered) {
          await client.query('ROLLBACK')
          return res.status(409).json({ success: false, error: 'treasury-funding-or-fee-coverage-changed', reason: providerSnapshot.reason || 'treasury-trx-below-fee-cap', submissionEnabled: false })
        }
        // Use the latest chain read and provider-available TRX. Reserve a separate
        // fee cap for every unresolved USDT/TRX payout plus this new request.
        nativeBalanceSun = providerSnapshot.treasuryTrxBalanceSun
        const pendingTrxFees = await client.query(`
          SELECT COUNT(*)::text AS count
            FROM trc20_token_clone.treasury_trx_withdrawal_requests
           WHERE treasury_address = $1
             AND status IN ('broadcasting','provider-pending','broadcast-accepted','broadcast-unknown')
        `, [treasuryAddress])
        const pendingUsdtCount = String(unsettled.rows[0]?.count || '0')
        const pendingTrxCount = String(pendingTrxFees.rows[0]?.count || '0')
        const requiredFeeReserveSun = requiredTreasuryFeeReserveSun(
          configuredFeeLimit, pendingUsdtCount, pendingTrxCount,
        )
        if (requiredFeeReserveSun === null
          || !treasuryFeeReserveCovered(
            nativeBalanceSun, providerSnapshot.providerAvailableTrxBaseUnits, requiredFeeReserveSun,
          )) {
          await client.query('ROLLBACK')
          return res.status(409).json({
            success: false,
            error: 'treasury-trx-fee-reservations-exceed-available-balance',
            pendingUsdtPayoutCount: pendingUsdtCount,
            pendingTrxPayoutCount: pendingTrxCount,
            requiredFeeReserveSun,
            treasuryTrxBalanceSun: nativeBalanceSun,
            providerAvailableTrxBaseUnits: providerSnapshot.providerAvailableTrxBaseUnits,
            message: 'Chain-observed and provider-available TRX must cover one fee cap per unresolved payout plus this request. No payout was submitted.',
          })
        }
        const chainAvailable = unreservedTreasuryBalance(balance.toString(), reservedBaseUnits.toString())
        const providerAvailable = unreservedTreasuryBalance(providerSnapshot.providerAvailableBaseUnits, reservedBaseUnits.toString())
        const availableBaseUnits = chainAvailable === null || providerAvailable === null ? null
          : (BigInt(chainAvailable) < BigInt(providerAvailable) ? chainAvailable : providerAvailable)
        if (availableBaseUnits === null || amount > BigInt(availableBaseUnits)) {
          await client.query('ROLLBACK')
          return res.status(409).json({
            success: false,
            error: 'treasury-usdt-insufficient-after-reservations',
            treasuryUsdtBalanceBaseUnits: balance.toString(),
            outstandingReservationBaseUnits: reservedBaseUnits.toString(),
            availableUsdtBaseUnits: availableBaseUnits ?? '0',
            requestedAmountBaseUnits: amount.toString(),
            message: 'The verified treasury balance is not sufficient after accounting for other unresolved withdrawals.',
          })
        }

        const [spent, sponsorBudgetUsage] = await Promise.all([
          client.query(`
            SELECT COALESCE(SUM(amount_base_units), 0)::text AS amount
              FROM trc20_token_clone.treasury_withdrawal_requests
             WHERE created_at >= date_trunc('day', now())
               AND status <> 'rejected'
          `),
          client.query(`
            SELECT COALESCE(SUM(amount_base_units), 0)::text AS amount,
                   MIN(sponsor_agreement_budget_base_units)::text AS min_budget_cap,
                   MAX(sponsor_agreement_budget_base_units)::text AS max_budget_cap,
                   COUNT(*) FILTER (
                     WHERE sponsor_organization_reference IS NULL
                        OR sponsor_agreement_reference IS NULL
                        OR sponsor_agreement_budget_base_units IS NULL
                   )::text AS unpinned_agreement_rows
              FROM trc20_token_clone.treasury_withdrawal_requests
             WHERE treasury_address=$1
               AND (
                 (sponsor_organization_reference=$2 AND sponsor_agreement_reference=$3)
                 OR sponsor_organization_reference IS NULL
                 OR sponsor_agreement_reference IS NULL
               )
               AND status NOT IN ('rejected','failed')
          `, [treasuryAddress, config.sponsorOrganizationReference, config.sponsorAgreementReference]),
        ])
        const alreadyReserved = BigInt(spent.rows[0]?.amount || '0')
        const sponsorBudgetCapConsistent = sponsorPrincipalBudgetCapMatches(config.sponsorTotalBudgetBaseUnits, {
          minimumStoredBudgetBaseUnits: sponsorBudgetUsage.rows[0]?.min_budget_cap ?? null,
          maximumStoredBudgetBaseUnits: sponsorBudgetUsage.rows[0]?.max_budget_cap ?? null,
          unpinnedAgreementRows: String(sponsorBudgetUsage.rows[0]?.unpinned_agreement_rows || '0'),
        })
        if (!sponsorBudgetCapConsistent) {
          await client.query('ROLLBACK')
          return res.status(409).json({
            success: false,
            error: 'sponsor-principal-agreement-budget-cap-mismatch',
            transactionSubmitted: false,
            message: 'The configured USDT commitment differs from the stored agreement cap, or prior requests lack a cap snapshot. No Fireblocks transfer was requested.',
          })
        }
        const sponsorBudget = calculateSponsorPrincipalBudgetState(
          config.sponsorTotalBudgetBaseUnits,
          String(sponsorBudgetUsage.rows[0]?.amount || '0'),
          amount.toString(),
        )
        if (!sponsorBudget || !sponsorBudget.withinBudget) {
          await client.query('ROLLBACK')
          return res.status(409).json({
            success: false,
            error: 'sponsor-principal-agreement-budget-exceeded',
            sponsorPrincipalBudget: sponsorBudget ? {
              totalBaseUnits: sponsorBudget.totalBudgetBaseUnits,
              usedAndReservedBaseUnits: sponsorBudget.usedBaseUnits,
              remainingBaseUnits: sponsorBudget.remainingBaseUnits,
              requestedBaseUnits: sponsorBudget.requestedBaseUnits,
            } : null,
            transactionSubmitted: false,
            message: 'The requested USDT principal exceeds the remaining commitment recorded for this sponsor agreement. No Fireblocks transfer was requested.',
          })
        }
        if (alreadyReserved + amount > dailyLimit) {
          await client.query('ROLLBACK')
          return res.status(429).json({ success: false, error: 'treasury-daily-limit-exceeded' })
        }
        const inserted = await client.query(`
          INSERT INTO trc20_token_clone.treasury_withdrawal_requests
            (idempotency_key, owner_address, treasury_address, recipient_address, token_contract,
             sponsor_organization_reference, sponsor_agreement_reference, sponsor_agreement_budget_base_units,
             recipient_approval_request_id, amount_base_units, status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'broadcasting')
          RETURNING *
        `, [
          body.idempotencyKey, auth.ownerAddress, treasuryAddress, body.recipientAddress, USDT_MAINNET,
          config.sponsorOrganizationReference, config.sponsorAgreementReference,
          config.sponsorTotalBudgetBaseUnits, sponsorRecipientApprovalRequestId, amount.toString(),
        ])
        reservation = inserted.rows[0]
        await client.query('COMMIT')
      } catch (error) {
        try { await client.query('ROLLBACK') } catch {}
        if (error?.code === '23505') {
          const existing = await db.query('SELECT * FROM trc20_token_clone.treasury_withdrawal_requests WHERE idempotency_key = $1', [body.idempotencyKey])
          if (existing.rows.length) {
            const prior = existing.rows[0]
            if (!matchesTreasuryWithdrawalRequest(prior, {
              ownerAddress: auth.ownerAddress,
              treasuryAddress,
              recipientAddress: body.recipientAddress,
              amountBaseUnits: amount.toString(),
              sponsorOrganizationReference: config.sponsorOrganizationReference,
              sponsorAgreementReference: config.sponsorAgreementReference,
            sponsorAgreementBudgetBaseUnits: config.sponsorTotalBudgetBaseUnits,
            })) {
              return res.status(409).json({
                success: false,
                error: 'idempotency-key-conflict',
                message: 'The existing request is bound to a different withdrawal intent or sponsor agreement. No second Fireblocks transfer was requested.',
              })
            }
            return res.status(200).json({ success: true, duplicate: true, withdrawal: safeStatus(prior), note: 'Existing request returned; no second transfer was broadcast.' })
          }
        }
        throw error
      } finally {
        client.release()
      }

      const fireblocks = managedSigner()
      let estimatedFeeSun = null
      try {
        const estimate = await fireblocks.estimateUsdtTransferFee({
          recipientAddress: body.recipientAddress,
          amountUsdt: formatUnitsDecimal(amount, 6),
        })
        estimatedFeeSun = maxFireblocksEstimatedFeeSun(estimate)
      } catch {
        // Do not submit when the provider cannot produce a complete fee estimate.
      }
      if (estimatedFeeSun === null || BigInt(estimatedFeeSun) > BigInt(String(configuredFeeLimit))) {
        const estimateUnavailable = estimatedFeeSun === null
        await db.query(`UPDATE trc20_token_clone.treasury_withdrawal_requests
          SET status='rejected', failure_code=$2, updated_at=now()
          WHERE id=$1 AND status='broadcasting'`,
        [reservation.id, estimateUnavailable ? 'fireblocks-fee-estimate-unavailable' : 'fireblocks-estimated-fee-exceeds-reserve'])
        return res.status(estimateUnavailable ? 503 : 409).json({
          success: false,
          status: 'rejected',
          error: estimateUnavailable ? 'fireblocks-fee-estimate-unavailable' : 'fireblocks-estimated-fee-exceeds-reserve',
          ...(estimatedFeeSun !== null ? { estimatedFeeSun } : {}),
          feeReserveSun: String(configuredFeeLimit),
          transactionSubmitted: false,
          note: 'No Fireblocks transfer request was created because the fee estimate was unavailable or exceeded the configured reserve. This estimate is not a provider-enforced hard fee cap.',
        })
      }
      let providerTransaction
      try {
        providerTransaction = await fireblocks.createUsdtTransfer({
          recipientAddress: body.recipientAddress,
          amountUsdt: formatUnitsDecimal(amount, 6),
          externalTxId: body.idempotencyKey,
          note: 'TRON Token Studio owner-authorized treasury payout',
        })
      } catch {
        // Provider timeout is ambiguous. Look up the same externalTxId and never
        // blindly create a second transfer.
        try { providerTransaction = await fireblocks.findTransactionByExternalId(body.idempotencyKey) } catch {}
      }
      const providerTransactionId = typeof providerTransaction?.id === 'string' ? providerTransaction.id
        : typeof providerTransaction?.transactionId === 'string' ? providerTransaction.transactionId : ''
      if (!providerTransactionId) {
        await db.query(`UPDATE trc20_token_clone.treasury_withdrawal_requests
          SET status='broadcast-unknown', failure_code='provider-transaction-reference-unavailable', updated_at=now()
          WHERE id=$1`, [reservation.id])
        return res.status(202).json({ success: false, status: 'broadcast-unknown', error: 'provider-transaction-reference-unavailable', idempotencyKey: body.idempotencyKey, note: 'Provider outcome is ambiguous. Do not submit a replacement request; reconcile using the same external transaction ID.' })
      }

      let providerState = classifyFireblocksTransaction(providerTransaction)
      if (!providerState.transactionHash && !providerState.terminalFailure) {
        try {
          providerTransaction = await fireblocks.getTransaction(providerTransactionId)
          providerState = classifyFireblocksTransaction(providerTransaction)
        } catch {}
      }
      const ledgerState = fireblocksPayoutLedgerState(providerState)
      const nextStatus = ledgerState.status
      const saved = await db.query(`UPDATE trc20_token_clone.treasury_withdrawal_requests
        SET status=$2, transaction_hash=$3, provider_transaction_id=$4, provider_status=$5,
            failure_code=$6, updated_at=now()
        WHERE id=$1 RETURNING *`,
      [reservation.id, nextStatus, providerState.transactionHash, providerTransactionId,
        providerState.providerStatus, ledgerState.failureCode])
      return res.status(202).json({
        success: nextStatus !== 'broadcast-unknown', status: nextStatus, withdrawal: safeStatus(saved.rows[0]),
        note: nextStatus === 'broadcast-accepted'
          ? 'Provider returned a chain transaction ID. This is not confirmation; verify the solidified TRON receipt and official-USDT Transfer event.'
          : nextStatus === 'broadcast-unknown'
            ? 'Fireblocks reported a terminal state without a verified solidified TRON outcome. The USDT principal remains reserved; reconcile the same idempotency key and do not retry as a new payout.'
            : 'Provider created a request but no chain transaction ID is available yet. Funds remain reserved; poll this same idempotency key.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'treasury-withdrawal-unavailable' })
    }
  })

  router.post('/withdrawals/:idempotencyKey/verify', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const key = req.params.idempotencyKey
    if (!IDEMPOTENCY_PATTERN.test(key || '')) return res.status(400).json({ success: false, error: 'invalid-idempotency-key' })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const lookup = await db.query(
        'SELECT * FROM trc20_token_clone.treasury_withdrawal_requests WHERE idempotency_key = $1 AND owner_address = $2',
        [key, auth.ownerAddress],
      )
      if (!lookup.rows.length) return res.status(404).json({ success: false, error: 'withdrawal-not-found' })
      let row = await refreshProviderTransaction(db, lookup.rows[0])
      const terminalVerification = terminalTreasuryWithdrawalVerification(row)
      if (terminalVerification.terminal) {
        const httpStatus = terminalVerification.verification.status === 'confirmed' ? 200 : 202
        return res.status(httpStatus).json({
          success: terminalVerification.success,
          withdrawal: safeStatus(row),
          verification: terminalVerification.verification,
          ...(terminalVerification.verification.verified === false
            ? { note: 'Fireblocks reported a terminal failure, but no solidified on-chain receipt has been verified. This is not proof of an on-chain failure.' }
            : {}),
        })
      }
      const txid = typeof row.transaction_hash === 'string' ? row.transaction_hash.trim() : ''
      if (!TXID_PATTERN.test(txid)) {
        const pending = ['provider-pending', 'broadcasting', 'broadcast-unknown'].includes(row.status)
        return res.status(pending ? 202 : 409).json({
          success: false,
          status: row.status,
          error: 'transaction-hash-not-available',
          withdrawal: safeStatus(row),
          note: 'Provider has not returned a chain transaction hash yet. The request remains reserved; use the same request reference and do not submit a replacement.',
        })
      }
      const tronWeb = tronWebFactory()
      const [transaction, transactionInfo] = await Promise.all([
        tronWeb.trx.getConfirmedTransaction(txid).catch(() => null),
        tronWeb.trx.getTransactionInfo(txid).catch(() => null),
      ])
      const evidence = verifyTreasuryTransferEvidence(tronWeb, {
        transaction, transactionInfo, transactionHash: txid,
        treasuryAddress: row.treasury_address,
        recipientAddress: row.recipient_address,
        amountBaseUnits: String(row.amount_base_units),
      })
      if (evidence.status === 'confirmed' || evidence.status === 'failed') {
        const updated = await db.query(
          `UPDATE trc20_token_clone.treasury_withdrawal_requests
              SET status = $2, failure_code = $3, updated_at = now()
            WHERE id = $1 AND status NOT IN ('confirmed','failed')
            RETURNING *`,
          [row.id, evidence.status, evidence.status === 'failed' ? evidence.reason : null],
        )
        const saved = updated.rows[0] || row
        return res.json({ success: evidence.status === 'confirmed', withdrawal: safeStatus(saved), verification: evidence })
      }
      return res.status(evidence.status === 'verification-mismatch' ? 409 : 202).json({
        success: false, withdrawal: safeStatus(row), verification: evidence,
        note: 'No confirmation is inferred from a transaction hash alone. Retry verification after the transaction is indexed/solidified.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'treasury-withdrawal-verification-unavailable' })
    }
  })

  router.get('/withdrawals/:idempotencyKey', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    if (!IDEMPOTENCY_PATTERN.test(req.params.idempotencyKey || '')) return res.status(400).json({ success: false, error: 'invalid-idempotency-key' })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const result = await db.query('SELECT * FROM trc20_token_clone.treasury_withdrawal_requests WHERE idempotency_key = $1 AND owner_address = $2', [req.params.idempotencyKey, auth.ownerAddress])
      if (!result.rows.length) return res.status(404).json({ success: false, error: 'withdrawal-not-found' })
      const row = await refreshProviderTransaction(db, result.rows[0])
      return res.json({ success: true, withdrawal: safeStatus(row) })
    } catch {
      return res.status(503).json({ success: false, error: 'treasury-withdrawal-unavailable' })
    }
  })


  // Native TRX treasury payouts are a separate, opt-in path with independent
  // limits. The same owner-only challenge session and per-request signature
  // apply; this route never borrows or fabricates chain balance.
  router.get('/trx-withdrawals/readiness', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    res.setHeader('Pragma', 'no-cache')
    const authResult = await authenticateOwner(req)
    if (!authResult.ok) return res.status(authResult.status).json({ success: false, error: authResult.error })

    const config = trxConfiguration(env)
    const treasuryAddress = typeof env.TREASURY_ADDRESS === 'string' ? env.TREASURY_ADDRESS.trim() : ''
    const db = getPool(env)
    const blockers = []
    let databaseReady = false
    let snapshot = { ok: false, reason: 'treasury-address-not-configured' }
    let reservedNativeSun = '0'
    let reservedFeeCapSun = '0'
    let availableNativeSun = '0'
    let dailyReservedSun = '0'
    let pendingTrxCount = '0'
    let pendingUsdtCount = '0'

    if (env.TREASURY_TRX_WITHDRAWALS_ENABLED !== 'true') blockers.push('trx-payout-feature-disabled')
    if (!config.configurationComplete) blockers.push('trx-withdrawal-configuration-incomplete')
    if (!ADDRESS_PATTERN.test(treasuryAddress)) blockers.push('treasury-address-not-configured')
    if (ADDRESS_PATTERN.test(treasuryAddress)) snapshot = await readManagedTreasuryTrxSnapshot(treasuryAddress)
    const outboundHistory = db && ADDRESS_PATTERN.test(treasuryAddress)
      ? await getFireblocksOutboundHistoryStatus({ env, treasuryAddress })
      : { verified: false, reason: 'fireblocks-vault-outbound-history-not-reconciled' }
    if (!outboundHistory.verified) blockers.push('fireblocks-vault-outbound-history-not-reconciled')
    if (!snapshot.ok) blockers.push(snapshot.reason || 'fireblocks-trx-funding-unverified')

    try {
      if (db) {
        await ensureSchema(db)
        await db.query('SELECT 1')
        databaseReady = true
        if (ADDRESS_PATTERN.test(treasuryAddress)) {
          const [trxReserved, trxPending, usdtPending, dailyReserved] = await Promise.all([
            db.query(`SELECT COALESCE(SUM(amount_base_units),0)::text AS amount
              FROM trc20_token_clone.treasury_trx_withdrawal_requests
              WHERE treasury_address=$1 AND status IN ('broadcasting','provider-pending','broadcast-accepted','broadcast-unknown')`, [treasuryAddress]),
            db.query(`SELECT COUNT(*)::text AS count
              FROM trc20_token_clone.treasury_trx_withdrawal_requests
              WHERE treasury_address=$1 AND status IN ('broadcasting','provider-pending','broadcast-accepted','broadcast-unknown')`, [treasuryAddress]),
            db.query(`SELECT COUNT(*)::text AS count
              FROM trc20_token_clone.treasury_withdrawal_requests
              WHERE treasury_address=$1 AND status IN ('broadcasting','provider-pending','broadcast-accepted','broadcast-unknown')`, [treasuryAddress]),
            db.query(`SELECT COALESCE(SUM(amount_base_units),0)::text AS amount
              FROM trc20_token_clone.treasury_trx_withdrawal_requests
              WHERE treasury_address=$1 AND created_at >= date_trunc('day',now()) AND status <> 'rejected'`, [treasuryAddress]),
          ])
          reservedNativeSun = String(trxReserved.rows[0]?.amount || '0')
          pendingTrxCount = String(trxPending.rows[0]?.count || '0')
          pendingUsdtCount = String(usdtPending.rows[0]?.count || '0')
          dailyReservedSun = String(dailyReserved.rows[0]?.amount || '0')

          const feeReservations = config.feeLimit * (BigInt(pendingTrxCount) + BigInt(pendingUsdtCount) + 1n)
          reservedFeeCapSun = feeReservations.toString()
          if (snapshot.ok) {
            const unreserved = unreservedTreasuryBalance(snapshot.spendableTrxBaseUnits, reservedNativeSun)
            const postFee = unreserved === null ? 0n : BigInt(unreserved) - feeReservations
            availableNativeSun = (postFee > 0n ? postFee : 0n).toString()
          }
        }
      }
    } catch {
      databaseReady = false
      blockers.push('chain-or-database-read-failed')
    }

    if (!databaseReady) blockers.push('database-not-ready')
    if (snapshot.ok) {
      if (BigInt(snapshot.spendableTrxBaseUnits) <= 0n) blockers.push('treasury-trx-balance-zero-or-unavailable')
      if (!treasuryFeeCapCovered(snapshot.treasuryTrxBalanceSun, String(config.feeLimit))) blockers.push('treasury-trx-below-fee-cap')
      if (databaseReady && BigInt(availableNativeSun) <= 0n) blockers.push('treasury-trx-no-unreserved-payout-balance')
    }

    const preflightChecksPassed = config.enabled && databaseReady && snapshot.ok && blockers.length === 0
    const payoutExecution = treasuryTrxPayoutExecutionState(preflightChecksPassed)
    return res.json({
      success: true,
      network: 'mainnet',
      asset: 'TRX',
      decimals: 6,
      ...payoutExecution,
      preflightChecksPassed,
      ownerAddress: authResult.ownerAddress,
      treasuryAddress: ADDRESS_PATTERN.test(treasuryAddress) ? treasuryAddress : null,
      configuration: {
        enabled: config.enabled,
        configurationComplete: config.configurationComplete,
        featureFlagEnabled: config.featureFlagEnabled,
        missing: config.missing,
        signerMode: config.signerMode,
        providerConfigured: typeof managedSigner()?.isTrxAssetConfigured === 'function' && managedSigner().isTrxAssetConfigured() === true,
      },
      databaseReady,
      externalOutboundHistoryVerified: outboundHistory.verified === true,
      externalOutboundHistoryCheckedAt: outboundHistory.checkedAt || null,
      externalOutboundHistoryAgeMs: outboundHistory.ageMs ?? null,
      externalOutboundUsdtBaseUnits: outboundHistory.verified ? String(outboundHistory.externalUsdtBaseUnits || '0') : null,
      externalOutboundTrxBaseUnits: outboundHistory.verified ? String(outboundHistory.externalTrxBaseUnits || '0') : null,
      externalOutboundNetworkFeeTrxBaseUnits: outboundHistory.verified ? String(outboundHistory.networkFeeTrxBaseUnits || '0') : null,
      ...(snapshot.ok ? {
        providerAssetId: snapshot.providerAssetId,
        providerAvailableTrxBaseUnits: snapshot.providerAvailableBaseUnits,
        treasuryTrxBalanceSun: snapshot.treasuryTrxBalanceSun,
        spendableTrxBaseUnits: snapshot.spendableTrxBaseUnits,
        providerVaultAddressVerified: snapshot.vaultAddressVerified,
        nativeAssetIdentityVerified: snapshot.nativeAssetIdentityVerified,
      } : {}),
      outstandingTrxPrincipalSun: reservedNativeSun,
      reservedFeeCapSun,
      availableTrxBaseUnits: availableNativeSun,
      dailyReservedTrxBaseUnits: dailyReservedSun,
      maxPayoutTrx: typeof env.TREASURY_MAX_PAYOUT_TRX === 'string' ? env.TREASURY_MAX_PAYOUT_TRX : null,
      dailyLimitTrx: typeof env.TREASURY_DAILY_LIMIT_TRX === 'string' ? env.TREASURY_DAILY_LIMIT_TRX : null,
      payoutBlockers: [...new Set([...blockers, ...(payoutExecution.executionBlocker ? [payoutExecution.executionBlocker] : [])])],
      note: 'Readiness is not a payout authorization. Every TRX payout requires owner authorization, a configured Fireblocks vault, real TRX covering principal and the reserved fee cap, and a verified chain receipt.',
    })
  })

  router.post('/trx-withdrawals', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    if (REAL_VALUE_TRX_PAYOUT_EXECUTION_DISABLED) {
      return res.status(503).json({
        success: false,
        error: 'native-trx-payout-execution-disabled-in-this-build',
        submissionEnabled: false,
      })
    }
    const authResult = await authenticateOwner(req)
    if (!authResult.ok) return res.status(authResult.status).json({ success: false, error: authResult.error })

    const config = trxConfiguration(env)
    if (!config.enabled) {
      return res.status(503).json({
        success: false,
        error: 'treasury-trx-withdrawals-disabled',
        missing: config.missing,
        submissionEnabled: false,
      })
    }

    const origin = req.get('origin')
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    const amount = parsePositiveDecimal(body.amountTrx, 6)
    const authorizationExpiresAt = body.authorizationExpiresAt
    if (!origin || !ADDRESS_PATTERN.test(body.recipientAddress || '')
      || body.recipientAddress === env.TREASURY_ADDRESS
      || !amount || amount > config.maxPayout
      || typeof body.idempotencyKey !== 'string' || !IDEMPOTENCY_PATTERN.test(body.idempotencyKey)
      || !isTreasuryAuthorizationExpiryValid(authorizationExpiresAt, now().getTime(), OWNER_PAYOUT_AUTHORIZATION_MAX_FUTURE_MS)
      || typeof body.authorizationMessage !== 'string'
      || typeof body.authorizationSignature !== 'string'
      || !OWNER_PAYOUT_SIGNATURE_PATTERN.test(body.authorizationSignature)) {
      return res.status(400).json({ success: false, error: 'invalid-trx-withdrawal-request' })
    }

    const treasuryAddress = typeof env.TREASURY_ADDRESS === 'string' ? env.TREASURY_ADDRESS.trim() : ''
    try {
      const tronWeb = tronWebFactory()
      if (!tronWeb.isAddress(body.recipientAddress) || !ADDRESS_PATTERN.test(treasuryAddress)
        || !tronWeb.isAddress(treasuryAddress) || treasuryAddress === body.recipientAddress) {
        return res.status(400).json({ success: false, error: 'invalid-treasury-or-recipient' })
      }
      const canonicalMessage = buildTreasuryTrxWithdrawalAuthorizationMessage({
        origin,
        ownerAddress: authResult.ownerAddress,
        treasuryAddress,
        recipientAddress: body.recipientAddress,
        amountBaseUnits: amount.toString(),
        idempotencyKey: body.idempotencyKey,
        authorizationExpiresAt,
      })
      if (body.authorizationMessage !== canonicalMessage) {
        return res.status(400).json({ success: false, error: 'payout-authorization-message-mismatch' })
      }
      const signatureValid = await verifyTreasuryOwnerPayoutSignature(tronWeb, {
        message: canonicalMessage,
        signature: body.authorizationSignature,
        expectedOwnerAddress: authResult.ownerAddress,
      })
      if (!signatureValid) return res.status(403).json({ success: false, error: 'invalid-owner-payout-signature' })

      const db = getPool(env)
      if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
      await ensureSchema(db)

      const client = await db.connect()
      let reservation
      try {
        await client.query('BEGIN')
        await client.query("SELECT pg_advisory_xact_lock(hashtext('tron-token-studio-treasury-withdrawals-mainnet'))")
        const existing = await client.query(
          'SELECT * FROM trc20_token_clone.treasury_trx_withdrawal_requests WHERE idempotency_key=$1 FOR UPDATE',
          [body.idempotencyKey],
        )
        if (existing.rows.length) {
          const prior = existing.rows[0]
          await client.query('COMMIT')
          if (!matchesTreasuryTrxWithdrawalRequest(prior, {
            ownerAddress: authResult.ownerAddress,
            treasuryAddress,
            recipientAddress: body.recipientAddress,
            amountBaseUnits: amount.toString(),
          })) {
            return res.status(409).json({
              success: false,
              error: 'idempotency-key-conflict',
              message: 'This request key is already bound to a different owner, recipient, treasury, or amount. No second transfer was submitted.',
            })
          }
          const refreshed = await refreshProviderTrxTransaction(db, prior)
          return res.status(200).json({
            success: true,
            duplicate: true,
            withdrawal: safeTrxStatus(refreshed),
            note: 'Matching request returned; no second provider transfer was submitted.',
          })
        }

        const snapshot = await readManagedTreasuryTrxSnapshot(treasuryAddress)
        if (!snapshot.ok) {
          await client.query('ROLLBACK')
          return res.status(503).json({
            success: false,
            error: 'treasury-provider-funding-not-verified',
            reason: snapshot.reason,
            submissionEnabled: false,
          })
        }

        const [trxReserved, pendingTrxCount, pendingUsdtCount, dailyReserved] = await Promise.all([
          client.query(`SELECT COALESCE(SUM(amount_base_units),0)::text AS amount
            FROM trc20_token_clone.treasury_trx_withdrawal_requests
            WHERE treasury_address=$1 AND status IN ('broadcasting','provider-pending','broadcast-accepted','broadcast-unknown')`, [treasuryAddress]),
          client.query(`SELECT COUNT(*)::text AS count
            FROM trc20_token_clone.treasury_trx_withdrawal_requests
            WHERE treasury_address=$1 AND status IN ('broadcasting','provider-pending','broadcast-accepted','broadcast-unknown')`, [treasuryAddress]),
          client.query(`SELECT COUNT(*)::text AS count
            FROM trc20_token_clone.treasury_withdrawal_requests
            WHERE treasury_address=$1 AND status IN ('broadcasting','provider-pending','broadcast-accepted','broadcast-unknown')`, [treasuryAddress]),
          client.query(`SELECT COALESCE(SUM(amount_base_units),0)::text AS amount
            FROM trc20_token_clone.treasury_trx_withdrawal_requests
            WHERE treasury_address=$1 AND created_at >= date_trunc('day',now()) AND status <> 'rejected'`, [treasuryAddress]),
        ])
        const nativeReserved = BigInt(trxReserved.rows[0]?.amount || '0')
        const pendingFeeCount = BigInt(pendingTrxCount.rows[0]?.count || '0')
          + BigInt(pendingUsdtCount.rows[0]?.count || '0') + 1n
        const reservedFeeSun = config.feeLimit * pendingFeeCount
        const unreservedNative = unreservedTreasuryBalance(snapshot.spendableTrxBaseUnits, nativeReserved.toString())
        const freeForPrincipal = unreservedNative === null ? 0n : BigInt(unreservedNative) - reservedFeeSun
        if (freeForPrincipal < amount) {
          await client.query('ROLLBACK')
          return res.status(409).json({
            success: false,
            error: 'treasury-trx-insufficient-after-reservations',
            treasuryTrxBalanceSun: snapshot.treasuryTrxBalanceSun,
            providerAvailableTrxBaseUnits: snapshot.providerAvailableBaseUnits,
            outstandingTrxPrincipalSun: nativeReserved.toString(),
            reservedFeeCapSun: reservedFeeSun.toString(),
            availableTrxBaseUnits: (freeForPrincipal > 0n ? freeForPrincipal : 0n).toString(),
            requestedAmountBaseUnits: amount.toString(),
            message: 'Verified real treasury TRX is insufficient after outstanding payouts and the conservative fee reserve.',
          })
        }

        const alreadyReserved = BigInt(dailyReserved.rows[0]?.amount || '0')
        if (alreadyReserved + amount > config.dailyLimit) {
          await client.query('ROLLBACK')
          return res.status(429).json({ success: false, error: 'treasury-trx-daily-limit-exceeded' })
        }

        const inserted = await client.query(`
          INSERT INTO trc20_token_clone.treasury_trx_withdrawal_requests
            (idempotency_key,owner_address,treasury_address,recipient_address,amount_base_units,status)
          VALUES ($1,$2,$3,$4,$5,'broadcasting')
          RETURNING *
        `, [body.idempotencyKey, authResult.ownerAddress, treasuryAddress, body.recipientAddress, amount.toString()])
        reservation = inserted.rows[0]
        await client.query('COMMIT')
      } catch (error) {
        try { await client.query('ROLLBACK') } catch {}
        if (error?.code === '23505') {
          const existing = await db.query(
            'SELECT * FROM trc20_token_clone.treasury_trx_withdrawal_requests WHERE idempotency_key=$1',
            [body.idempotencyKey],
          )
          if (existing.rows.length) {
            return res.status(200).json({
              success: true,
              duplicate: true,
              withdrawal: safeTrxStatus(existing.rows[0]),
              note: 'Existing native TRX request returned; no second transfer was submitted.',
            })
          }
        }
        throw error
      } finally {
        client.release()
      }

      const fireblocks = managedSigner()
      let estimatedFeeSun = null
      try {
        const estimate = await fireblocks.estimateTrxTransferFee({
          recipientAddress: body.recipientAddress,
          amountTrx: formatUnitsDecimal(amount, 6),
        })
        estimatedFeeSun = maxFireblocksEstimatedFeeSun(estimate)
      } catch {
        // Do not submit when the provider cannot produce a complete fee estimate.
      }
      if (estimatedFeeSun === null || BigInt(estimatedFeeSun) > config.feeLimit) {
        const estimateUnavailable = estimatedFeeSun === null
        await db.query(`UPDATE trc20_token_clone.treasury_trx_withdrawal_requests
          SET status='rejected', failure_code=$2, updated_at=now()
          WHERE id=$1 AND status='broadcasting'`,
        [reservation.id, estimateUnavailable ? 'fireblocks-fee-estimate-unavailable' : 'fireblocks-estimated-fee-exceeds-reserve'])
        return res.status(estimateUnavailable ? 503 : 409).json({
          success: false,
          status: 'rejected',
          error: estimateUnavailable ? 'fireblocks-fee-estimate-unavailable' : 'fireblocks-estimated-fee-exceeds-reserve',
          ...(estimatedFeeSun !== null ? { estimatedFeeSun } : {}),
          feeReserveSun: config.feeLimit.toString(),
          transactionSubmitted: false,
          note: 'No Fireblocks transfer request was created because the fee estimate was unavailable or exceeded the configured reserve. This estimate is not a provider-enforced hard fee cap.',
        })
      }
      let providerTransaction
      try {
        providerTransaction = await fireblocks.createTrxTransfer({
          recipientAddress: body.recipientAddress,
          amountTrx: formatUnitsDecimal(amount, 6),
          externalTxId: body.idempotencyKey,
          note: 'TRON Token Studio owner-authorized treasury TRX payout',
        })
      } catch {
        // Fireblocks may have accepted the first request despite a network error.
        // Resolve the original external ID before any new request can be created.
        try { providerTransaction = await fireblocks.findTransactionByExternalId(body.idempotencyKey) } catch {}
      }

      const providerTransactionId = typeof providerTransaction?.id === 'string' ? providerTransaction.id
        : typeof providerTransaction?.transactionId === 'string' ? providerTransaction.transactionId : ''
      if (!providerTransactionId) {
        await db.query(`UPDATE trc20_token_clone.treasury_trx_withdrawal_requests
          SET status='broadcast-unknown', provider_status='UNKNOWN',
              failure_code='provider-transaction-reference-unavailable', updated_at=now()
          WHERE id=$1`, [reservation.id])
        return res.status(202).json({
          success: false,
          status: 'broadcast-unknown',
          error: 'provider-transaction-reference-unavailable',
          idempotencyKey: body.idempotencyKey,
          note: 'Provider outcome is ambiguous. Do not submit a replacement; reconcile the same external transaction ID.',
        })
      }

      let providerState = classifyFireblocksTransaction(providerTransaction)
      if (!providerState.transactionHash && !providerState.terminalFailure) {
        try {
          providerTransaction = await fireblocks.getTransaction(providerTransactionId)
          providerState = classifyFireblocksTransaction(providerTransaction)
        } catch {}
      }
      const ledgerState = fireblocksPayoutLedgerState(providerState)
      const nextStatus = ledgerState.status
      const saved = await db.query(`UPDATE trc20_token_clone.treasury_trx_withdrawal_requests
        SET status=$2, transaction_hash=$3, provider_transaction_id=$4, provider_status=$5,
            failure_code=$6, updated_at=now()
        WHERE id=$1 RETURNING *`,
      [reservation.id, nextStatus, providerState.transactionHash, providerTransactionId,
        providerState.providerStatus, ledgerState.failureCode])
      return res.status(202).json({
        success: nextStatus !== 'broadcast-unknown',
        status: nextStatus,
        withdrawal: safeTrxStatus(saved.rows[0]),
        note: nextStatus === 'broadcast-accepted'
          ? 'Fireblocks returned a TRON chain transaction ID. Verify the solidified transaction before treating the transfer as complete.'
          : nextStatus === 'broadcast-unknown'
            ? 'Fireblocks reported a terminal state without a verified solidified TRON outcome. The TRX amount remains reserved; reconcile the same idempotency key and do not retry as a new payout.'
            : 'Fireblocks created a request but no chain hash is available yet. Funds remain reserved; look up this same idempotency key.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'treasury-trx-withdrawal-unavailable' })
    }
  })

  router.post('/trx-withdrawals/:idempotencyKey/verify', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const authResult = await authenticateOwner(req)
    if (!authResult.ok) return res.status(authResult.status).json({ success: false, error: authResult.error })
    const key = req.params.idempotencyKey
    if (!IDEMPOTENCY_PATTERN.test(key || '')) return res.status(400).json({ success: false, error: 'invalid-idempotency-key' })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })

    try {
      await ensureSchema(db)
      const lookup = await db.query(
        'SELECT * FROM trc20_token_clone.treasury_trx_withdrawal_requests WHERE idempotency_key=$1 AND owner_address=$2',
        [key, authResult.ownerAddress],
      )
      if (!lookup.rows.length) return res.status(404).json({ success: false, error: 'trx-withdrawal-not-found' })

      const row = await refreshProviderTrxTransaction(db, lookup.rows[0])
      if (row.status === 'confirmed') {
        return res.json({
          success: true,
          withdrawal: safeTrxStatus(row),
          verification: { verified: true, status: 'confirmed', reason: 'previously-verified-solidified-native-transfer' },
        })
      }
      // A provider-reported failure is not an on-chain receipt. Only release a
      // failed withdrawal as independently verified if our chain verifier set
      // the reason recorded below.
      if (row.status === 'failed' && String(row.failure_code || '').startsWith('confirmed-solidified-')) {
        return res.status(202).json({
          success: false,
          withdrawal: safeTrxStatus(row),
          verification: { verified: true, status: 'failed', reason: String(row.failure_code) },
        })
      }
      if (row.status === 'failed') {
        return res.status(202).json({
          success: false,
          withdrawal: safeTrxStatus(row),
          verification: { verified: false, status: 'provider-failed', reason: 'provider-terminal-failure-not-chain-verified' },
          note: 'Fireblocks reported a terminal failure, but no on-chain receipt was independently verified.',
        })
      }

      const txid = typeof row.transaction_hash === 'string' ? row.transaction_hash.trim() : ''
      if (!TXID_PATTERN.test(txid)) {
        const pending = ['provider-pending', 'broadcasting', 'broadcast-unknown'].includes(row.status)
        return res.status(pending ? 202 : 409).json({
          success: false,
          status: row.status,
          error: 'transaction-hash-not-available',
          withdrawal: safeTrxStatus(row),
          note: 'No chain hash is available yet. Keep the original request and do not submit a replacement.',
        })
      }

      const tronWeb = tronWebFactory()
      const [transaction, transactionInfo] = await Promise.all([
        tronWeb.trx.getConfirmedTransaction(txid).catch(() => null),
        tronWeb.trx.getTransactionInfo(txid).catch(() => null),
      ])
      const evidence = verifyTreasuryTrxTransferEvidence(tronWeb, {
        transaction,
        transactionInfo,
        transactionHash: txid,
        treasuryAddress: row.treasury_address,
        recipientAddress: row.recipient_address,
        amountBaseUnits: String(row.amount_base_units),
      })
      if (evidence.status === 'confirmed' || evidence.status === 'failed') {
        const updated = await db.query(`UPDATE trc20_token_clone.treasury_trx_withdrawal_requests
          SET status=$2, failure_code=$3, updated_at=now()
          WHERE id=$1 AND status NOT IN ('confirmed','failed') RETURNING *`,
        [row.id, evidence.status, evidence.status === 'failed' ? evidence.reason : null])
        const saved = updated.rows[0] || row
        return res.status(evidence.status === 'confirmed' ? 200 : 202).json({
          success: evidence.status === 'confirmed',
          withdrawal: safeTrxStatus(saved),
          verification: evidence,
        })
      }
      return res.status(evidence.status === 'verification-mismatch' ? 409 : 202).json({
        success: false,
        withdrawal: safeTrxStatus(row),
        verification: evidence,
        note: 'A hash alone is not confirmation; retry once the transaction is indexed in the solidified chain.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'treasury-trx-withdrawal-verification-unavailable' })
    }
  })

  router.get('/trx-withdrawals/:idempotencyKey', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const authResult = await authenticateOwner(req)
    if (!authResult.ok) return res.status(authResult.status).json({ success: false, error: authResult.error })
    const key = req.params.idempotencyKey
    if (!IDEMPOTENCY_PATTERN.test(key || '')) return res.status(400).json({ success: false, error: 'invalid-idempotency-key' })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const found = await db.query(
        'SELECT * FROM trc20_token_clone.treasury_trx_withdrawal_requests WHERE idempotency_key=$1 AND owner_address=$2',
        [key, authResult.ownerAddress],
      )
      if (!found.rows.length) return res.status(404).json({ success: false, error: 'trx-withdrawal-not-found' })
      const row = await refreshProviderTrxTransaction(db, found.rows[0])
      return res.json({
        success: true,
        withdrawal: safeTrxStatus(row),
        note: row.status === 'confirmed'
          ? 'The chain verifier confirmed the exact native TRX transfer.'
          : 'Provider and chain status are separate; only an independently verified solidified receipt is a confirmed transfer.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'treasury-trx-withdrawal-unavailable' })
    }
  })

  return router
}

export { parsePositiveDecimal }

export default createTreasuryWithdrawalsRouter
