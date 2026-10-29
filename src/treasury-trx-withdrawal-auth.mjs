const TRON_ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{24,128}$/
const BASE_UNIT_PATTERN = /^[1-9][0-9]{0,77}$/

/**
 * Canonical message for an expiring approval of one native-TRX transfer.
 * The amount is expressed in SUN, so signature verification does not depend
 * on floating-point decimal formatting.
 */
export function buildTreasuryTrxWithdrawalAuthorizationMessage({
  origin,
  ownerAddress,
  treasuryAddress,
  recipientAddress,
  amountSun,
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
  if (typeof amountSun !== 'string' || !BASE_UNIT_PATTERN.test(amountSun)) {
    throw new Error('A positive six-decimal native-TRX amount in SUN is required for payout authorization.')
  }
  if (BigInt(amountSun) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('The native-TRX amount exceeds the supported transaction-builder integer range.')
  }
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_PATTERN.test(idempotencyKey)
    || !idempotencyKey.startsWith('trx-withdrawal-')) {
    throw new Error('A valid TRX-specific one-use withdrawal request key is required.')
  }
  if (!Number.isSafeInteger(authorizationExpiresAt) || authorizationExpiresAt <= 0) {
    throw new Error('A valid payout authorization expiry timestamp is required.')
  }
  return [
    'TRON Token Studio treasury payout authorization',
    'Version: 1',
    'Purpose: authorize exactly one genuine native TRX transfer; no token is minted.',
    'Network: TRON Mainnet',
    'Asset: TRX',
    `Origin: ${origin}`,
    `Owner: ${ownerAddress}`,
    `Treasury: ${treasuryAddress}`,
    'Units: SUN (1 TRX = 1000000 SUN)',
    `Amount SUN: ${amountSun}`,
    `Recipient: ${recipientAddress}`,
    `Idempotency key: ${idempotencyKey}`,
    `Expires at Unix milliseconds: ${authorizationExpiresAt}`,
  ].join('\n')
}

export function parsePositiveTrxAmount(amountTrx) {
  if (typeof amountTrx !== 'string' || amountTrx.length > 64
    || !/^(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$/.test(amountTrx)) return null
  const [whole, fraction = ''] = amountTrx.split('.')
  if (whole.length > 16 || fraction.length > 6) return null
  const amountSun = BigInt(whole) * 1_000_000n
    + BigInt((fraction + '000000').slice(0, 6))
  if (amountSun <= 0n || amountSun > BigInt(Number.MAX_SAFE_INTEGER)) return null
  return amountSun.toString()
}

export function isTreasuryTrxAuthorizationExpiryValid(expiresAt, nowMs, maxFutureMs = 120_000) {
  return Number.isSafeInteger(expiresAt)
    && Number.isSafeInteger(nowMs)
    && Number.isSafeInteger(maxFutureMs)
    && maxFutureMs > 0
    && expiresAt > nowMs
    && expiresAt <= nowMs + maxFutureMs
}
