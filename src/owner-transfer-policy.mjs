const OWNER_CHECK_MAX_AGE_MS = 5 * 60 * 1000
const ALLOWED_CLOCK_SKEW_MS = 30 * 1000

/**
 * Mainnet sends in this owner-only app require a recent server-verified owner
 * treasury snapshot and a local signer whose address is the exact configured
 * funding address. Testnet transfers remain available for development.
 *
 * This is an application UX guard, not a substitute for the private key or
 * on-chain balance checks: every real transfer must still be signed locally
 * and checked against live chain state before broadcasting.
 */
export function ownerMainnetTransferAccessError({ network, from, snapshot, now = Date.now() } = {}) {
  if (network !== 'mainnet') return null

  if (snapshot?.ownerAccessVerified !== true
    || snapshot?.status !== 'on-chain-funding-read'
    || snapshot?.network !== 'mainnet'
    || snapshot?.onChainBalanceRead !== true) {
    return 'Mainnet transfers are owner-only. Sign the owner check and verify treasury funding before preparing a transfer.'
  }

  if (typeof from !== 'string' || !from
    || typeof snapshot.treasuryAddress !== 'string'
    || snapshot.treasuryAddress !== from) {
    return 'The unlocked sender is not the configured owner treasury. Unlock the authorized treasury wallet and verify it again.'
  }

  const checkedAt = typeof snapshot.checkedAt === 'string' ? Date.parse(snapshot.checkedAt) : NaN
  if (!Number.isFinite(checkedAt)
    || checkedAt > now + ALLOWED_CLOCK_SKEW_MS
    || now - checkedAt > OWNER_CHECK_MAX_AGE_MS) {
    return 'Owner treasury verification is missing or expired. Refresh the owner check before preparing or broadcasting a Mainnet transfer.'
  }

  return null
}

/** Throw a user-safe error when the Mainnet owner policy is not satisfied. */
export function assertOwnerMainnetTransferAccess(input) {
  const error = ownerMainnetTransferAccessError(input)
  if (error) throw new Error(error)
  return true
}
