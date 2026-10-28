const OWNER_ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{24,128}$/

export const TREASURY_PAYOUT_REFERENCE_STORAGE_KEY = 'tron-token-studio:treasury-payout-reference:v1'

function browserStorage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

/**
 * Persist only the owner address and opaque idempotency key needed to recover
 * a payout lookup after a reload. This is not an authentication credential and
 * never contains a private key, signed authorization, or claim of success.
 */
export function saveTreasuryPayoutReference(ownerAddress, idempotencyKey, storage = browserStorage()) {
  if (!storage || typeof storage.setItem !== 'function'
    || !OWNER_ADDRESS_PATTERN.test(ownerAddress || '')
    || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey || '')) return false
  try {
    storage.setItem(TREASURY_PAYOUT_REFERENCE_STORAGE_KEY, JSON.stringify({
      version: 1,
      ownerAddress,
      idempotencyKey,
      savedAt: Date.now(),
    }))
    return true
  } catch {
    return false
  }
}

export function readTreasuryPayoutReference(storage = browserStorage()) {
  if (!storage || typeof storage.getItem !== 'function') return null
  try {
    const raw = storage.getItem(TREASURY_PAYOUT_REFERENCE_STORAGE_KEY)
    const parsed = JSON.parse(raw || 'null')
    if (!parsed || parsed.version !== 1
      || !OWNER_ADDRESS_PATTERN.test(parsed.ownerAddress || '')
      || !IDEMPOTENCY_KEY_PATTERN.test(parsed.idempotencyKey || '')
      || !Number.isFinite(parsed.savedAt)) return null
    return {
      version: 1,
      ownerAddress: parsed.ownerAddress,
      idempotencyKey: parsed.idempotencyKey,
      savedAt: parsed.savedAt,
    }
  } catch {
    return null
  }
}
