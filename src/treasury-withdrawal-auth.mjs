const TRON_ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{24,128}$/
const BASE_UNIT_PATTERN = /^[1-9][0-9]{0,77}$/

export const OFFICIAL_TRON_MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

/**
 * Canonical human-readable payload for a one-time owner approval.
 * A signature authorizes only this exact transfer request; it is not a chain transaction.
 */
export function buildTreasuryWithdrawalAuthorizationMessage({
  origin,
  ownerAddress,
  treasuryAddress,
  recipientAddress,
  amountBaseUnits,
  idempotencyKey,
  authorizationExpiresAt,
} = {}) {
  if (typeof origin !== 'string' || !origin.trim() || origin.length > 512) {
    throw new Error('An exact application origin is required for payout authorization.')
  }
  for (const [field, value] of Object.entries({ ownerAddress, treasuryAddress, recipientAddress })) {
    if (typeof value !== 'string' || !TRON_ADDRESS_PATTERN.test(value)) {
      throw new Error(`A valid TRON ${field} is required for payout authorization.`)
    }
  }
  if (typeof amountBaseUnits !== 'string' || !BASE_UNIT_PATTERN.test(amountBaseUnits)) {
    throw new Error('A positive six-decimal USDT base-unit amount is required for payout authorization.')
  }
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
    throw new Error('A valid one-use withdrawal request key is required for payout authorization.')
  }
  if (!Number.isSafeInteger(authorizationExpiresAt) || authorizationExpiresAt <= 0) {
    throw new Error('A valid payout authorization expiry timestamp is required.')
  }
  return [
    'TRON Token Studio treasury payout authorization',
    'Version: 1',
    'Purpose: authorize exactly one genuine USDT transfer; this signature does not mint or create tokens.',
    'Network: TRON Mainnet',
    `Origin: ${origin}`,
    `Owner: ${ownerAddress}`,
    `Treasury: ${treasuryAddress}`,
    `Token contract: ${OFFICIAL_TRON_MAINNET_USDT}`,
    'Token decimals: 6',
    `Recipient: ${recipientAddress}`,
    `Amount base units: ${amountBaseUnits}`,
    `Idempotency key: ${idempotencyKey}`,
    `Expires at Unix milliseconds: ${authorizationExpiresAt}`,
  ].join('\n')
}

export function isTreasuryAuthorizationExpiryValid(expiresAt, nowMs, maxFutureMs = 120_000) {
  return Number.isSafeInteger(expiresAt)
    && Number.isSafeInteger(nowMs)
    && Number.isSafeInteger(maxFutureMs)
    && maxFutureMs > 0
    && expiresAt > nowMs
    && expiresAt <= nowMs + maxFutureMs
}


/**
 * Canonical approval payload for a single native TRX transfer from the
 * organization treasury. The signature authorizes the exact payout only.
 */
export function buildTreasuryTrxWithdrawalAuthorizationMessage({
  origin,
  ownerAddress,
  treasuryAddress,
  recipientAddress,
  amountBaseUnits,
  idempotencyKey,
  authorizationExpiresAt,
} = {}) {
  if (typeof origin !== 'string' || !origin.trim() || origin.length > 512) {
    throw new Error('An exact application origin is required for payout authorization.')
  }
  for (const [field, value] of Object.entries({ ownerAddress, treasuryAddress, recipientAddress })) {
    if (typeof value !== 'string' || !TRON_ADDRESS_PATTERN.test(value)) {
      throw new Error(`A valid TRON ${field} is required for payout authorization.`)
    }
  }
  if (typeof amountBaseUnits !== 'string' || !BASE_UNIT_PATTERN.test(amountBaseUnits)) {
    throw new Error('A positive six-decimal TRX base-unit amount is required for payout authorization.')
  }
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
    throw new Error('A valid one-use withdrawal request key is required for payout authorization.')
  }
  if (!Number.isSafeInteger(authorizationExpiresAt) || authorizationExpiresAt <= 0) {
    throw new Error('A valid payout authorization expiry timestamp is required.')
  }
  return [
    'TRON Token Studio treasury payout authorization',
    'Version: 1',
    'Purpose: authorize exactly one native TRX transfer; this signature does not create assets.',
    'Network: TRON Mainnet',
    `Origin: ${origin}`,
    `Owner: ${ownerAddress}`,
    `Treasury: ${treasuryAddress}`,
    'Asset: TRX',
    'Asset decimals: 6',
    `Recipient: ${recipientAddress}`,
    `Amount base units (sun): ${amountBaseUnits}`,
    `Idempotency key: ${idempotencyKey}`,
    `Expires at Unix milliseconds: ${authorizationExpiresAt}`,
  ].join('\\n')
}
