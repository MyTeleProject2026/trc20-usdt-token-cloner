const TRON_ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const CUSTOMER_REFERENCE_PATTERN = /^[A-Za-z0-9._:-]{12,128}$/
const BASE_UNIT_PATTERN = /^[1-9][0-9]{0,77}$/

export const OFFICIAL_TRON_MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

export function buildFincraPayoutAuthorizationMessage({
  origin,
  ownerAddress,
  recipientAddress,
  accountHolderName,
  amountBaseUnits,
  customerReference,
  authorizationExpiresAt,
} = {}) {
  if (typeof origin !== 'string' || !origin.trim() || origin.length > 512) throw new Error('An exact application origin is required.')
  if (typeof ownerAddress !== 'string' || !TRON_ADDRESS_PATTERN.test(ownerAddress)) throw new Error('A valid TRON owner address is required.')
  if (typeof recipientAddress !== 'string' || !TRON_ADDRESS_PATTERN.test(recipientAddress)) throw new Error('A valid TRON recipient address is required.')
  if (typeof accountHolderName !== 'string' || !accountHolderName.trim() || accountHolderName.trim().length > 120) throw new Error('A beneficiary account holder name is required.')
  if (typeof amountBaseUnits !== 'string' || !BASE_UNIT_PATTERN.test(amountBaseUnits)) throw new Error('A positive six-decimal USDT amount is required.')
  if (typeof customerReference !== 'string' || !CUSTOMER_REFERENCE_PATTERN.test(customerReference)) throw new Error('A unique payout reference is required.')
  if (!Number.isSafeInteger(authorizationExpiresAt) || authorizationExpiresAt <= 0) throw new Error('A valid payout authorization expiry is required.')
  return [
    'TRON Token Studio Fincra payout authorization',
    'Version: 1',
    'Purpose: authorize one Fincra USDT TRC20 payout; this signature does not mint or create tokens.',
    'Network: TRON Mainnet',
    'Provider: Fincra',
    'Payout scheme: usdt_trc20',
    'Origin: ' + origin,
    'Owner: ' + ownerAddress,
    'Token contract: ' + OFFICIAL_TRON_MAINNET_USDT,
    'Token decimals: 6',
    'Recipient: ' + recipientAddress,
    'Beneficiary name: ' + accountHolderName.trim(),
    'Amount base units: ' + amountBaseUnits,
    'Customer reference: ' + customerReference,
    'Expires at Unix milliseconds: ' + authorizationExpiresAt,
  ].join('\n')
}

export function isFincraPayoutAuthorizationExpiryValid(expiresAt, nowMs, maxFutureMs = 120_000) {
  return Number.isSafeInteger(expiresAt)
    && Number.isSafeInteger(nowMs)
    && Number.isSafeInteger(maxFutureMs)
    && maxFutureMs > 0
    && expiresAt > nowMs
    && expiresAt <= nowMs + maxFutureMs
}
