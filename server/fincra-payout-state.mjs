const RECONCILABLE_REQUEST_STATES = new Set([
  'submission-unknown',
  'provider-processing',
  'awaiting-chain-verification',
])
const FINAL_PROVIDER_STATES = new Set(['successful', 'failed'])

/**
 * Decide whether a signed Fincra final-status event may advance a local
 * request. This is provider reconciliation only: successful never means
 * chain-settled, and no result from this helper can initiate a payout.
 */
export function getFincraWebhookTransition({
  requestStatus,
  previousProviderStatus,
  providerStatus,
} = {}) {
  const current = typeof requestStatus === 'string' ? requestStatus.trim().toLowerCase() : ''
  const previous = typeof previousProviderStatus === 'string'
    ? previousProviderStatus.trim().toLowerCase() : ''
  const incoming = typeof providerStatus === 'string' ? providerStatus.trim().toLowerCase() : ''

  if (!RECONCILABLE_REQUEST_STATES.has(current)) {
    return { allowed: false, nextStatus: null, reason: 'payout-not-in-submitted-or-reconciliation-state' }
  }
  if (!FINAL_PROVIDER_STATES.has(incoming)) {
    return { allowed: false, nextStatus: null, reason: 'provider-status-not-final' }
  }
  if (FINAL_PROVIDER_STATES.has(previous) && previous !== incoming) {
    return { allowed: false, nextStatus: null, reason: 'terminal-provider-status-conflict' }
  }

  return {
    allowed: true,
    nextStatus: incoming === 'successful' ? 'awaiting-chain-verification' : 'provider-failed',
    reason: null,
  }
}

export const FINCRA_WEBHOOK_RECONCILABLE_STATES = Object.freeze([
  ...RECONCILABLE_REQUEST_STATES,
])
