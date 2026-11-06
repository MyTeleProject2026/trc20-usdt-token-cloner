/**
 * Normalize only Fincra's documented payout lifecycle states.
 * Generic transaction states (for example "pending") are deliberately not
 * promoted to payout processing; callers must leave the payout state unchanged.
 */
export function payoutStatusFromProvider(value) {
  const status = typeof value === 'string' ? value.trim().slice(0, 32).toLowerCase() : ''
  if (status === 'successful') return 'successful'
  if (status === 'failed') return 'failed'
  if (status === 'processing') return 'processing'
  return 'unknown'
}
