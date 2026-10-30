const TRON_ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{24,128}$/
const BASE_UNIT_PATTERN = /^[1-9][0-9]{0,77}$/

export const OFFICIAL_TRON_MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

/**
 * Domain-separated owner signature for a payout REQUEST only.
 * It must never be accepted by the transfer-submission endpoint.
 */
export function buildTreasuryPayoutRequestMessage({
  origin,
  requesterAddress,
  recipientAddress,
  amountBaseUnits,
  idempotencyKey,
  requestExpiresAt,
} = {}) {
  if (typeof origin !== 'string' || !origin.trim() || origin.length > 512) {
    throw new Error('An exact application origin is required.')
  }
  for (const [field, value] of Object.entries({ requesterAddress, recipientAddress })) {
    if (typeof value !== 'string' || !TRON_ADDRESS_PATTERN.test(value)) {
      throw new Error('A valid TRON ' + field + ' is required.')
    }
  }
  if (typeof amountBaseUnits !== 'string' || !BASE_UNIT_PATTERN.test(amountBaseUnits)) {
    throw new Error('A positive six-decimal USDT base-unit amount is required.')
  }
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
    throw new Error('A valid payout-request idempotency key is required.')
  }
  if (!Number.isSafeInteger(requestExpiresAt) || requestExpiresAt <= 0) {
    throw new Error('A valid payout-request expiry timestamp is required.')
  }
  return [
    'TRON Token Studio — Tether USDT payout REQUEST',
    'Version: 1',
    'Purpose: request independent organization review only. This signature does not authorize, sign, create, or broadcast a token transfer.',
    'Network: TRON Mainnet',
    'Asset: official Tether USDt (TRC-20)',
    'Token contract: ' + OFFICIAL_TRON_MAINNET_USDT,
    'Token decimals: 6',
    'Origin: ' + origin,
    'Requester: ' + requesterAddress,
    'Recipient: ' + recipientAddress,
    'Amount base units: ' + amountBaseUnits,
    'Idempotency key: ' + idempotencyKey,
    'Request expires at Unix milliseconds: ' + requestExpiresAt,
  ].join('\n')
}

export function parseUsdtAmountBaseUnits(value) {
  if (typeof value !== 'string') throw new Error('Enter a USDT amount.')
  const raw = value.trim()
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(raw)) {
    throw new Error('USDT amount must be a positive decimal with at most six decimal places.')
  }
  const [whole, fraction = ''] = raw.split('.')
  const amount = BigInt(whole) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6))
  if (amount <= 0n || amount > ((1n << 256n) - 1n)) {
    throw new Error('USDT amount must be a positive uint256 value.')
  }
  return amount.toString()
}

export function isPayoutRequestExpiryValid(expiresAt, nowMs, maxFutureMs = 120_000) {
  return Number.isSafeInteger(expiresAt)
    && Number.isSafeInteger(nowMs)
    && Number.isSafeInteger(maxFutureMs)
    && maxFutureMs > 0
    && expiresAt > nowMs
    && expiresAt <= nowMs + maxFutureMs
}
