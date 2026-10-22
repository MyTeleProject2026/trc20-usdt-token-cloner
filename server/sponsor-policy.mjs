const NETWORKS = new Set(['mainnet', 'shasta', 'nile'])
const ASSETS = new Set(['TRX', 'USDT', 'VTRC'])
const TOKEN_ASSETS = new Set(['USDT', 'VTRC'])
const PURPOSES = new Set(['network-fee', 'asset-grant'])
const BUDGET_STATUSES = new Set(['disabled', 'pending-review', 'active', 'paused', 'depleted'])

function baseUnits(value, { allowZero = false } = {}) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 78) return null
  if (!allowZero && value === '0') return null
  return BigInt(value)
}

/**
 * Pure accounting policy. This does not reserve database funds or submit a transaction.
 * Callers must still perform reservation atomically in PostgreSQL before any provider action.
 */
export function validateSponsorBudget(input) {
  if (!input || typeof input !== 'object') return { valid: false, reason: 'invalid-budget' }
  const { sponsorReference, network, asset, tokenContract = null, budgetBaseUnits, reservedBaseUnits, spentBaseUnits, status } = input
  if (typeof sponsorReference !== 'string' || !sponsorReference.trim() || sponsorReference.length > 128) {
    return { valid: false, reason: 'invalid-sponsor-reference' }
  }
  if (!NETWORKS.has(network)) return { valid: false, reason: 'invalid-network' }
  if (!ASSETS.has(asset)) return { valid: false, reason: 'invalid-asset' }
  if (asset === 'TRX' && tokenContract) return { valid: false, reason: 'native-trx-has-no-token-contract' }
  if (TOKEN_ASSETS.has(asset) && (typeof tokenContract !== 'string' || !tokenContract.trim())) {
    return { valid: false, reason: 'token-contract-required' }
  }
  if (!BUDGET_STATUSES.has(status)) return { valid: false, reason: 'invalid-budget-status' }
  const budget = baseUnits(budgetBaseUnits, { allowZero: true })
  const reserved = baseUnits(reservedBaseUnits, { allowZero: true })
  const spent = baseUnits(spentBaseUnits, { allowZero: true })
  if (budget === null || reserved === null || spent === null) return { valid: false, reason: 'invalid-base-units' }
  if (reserved + spent > budget) return { valid: false, reason: 'budget-exceeded' }
  return {
    valid: true,
    availableBaseUnits: (budget - reserved - spent).toString(),
    canReserve: status === 'active' && budget > reserved + spent,
  }
}

/**
 * Validates an intent only. It deliberately never authorizes, signs, broadcasts,
 * or represents an exchange credit. Pass a checksum-aware TRON address validator.
 */
export function validateSponsorTransferIntent(input, { isValidAddress, maxTransferBaseUnits, allowedTokenContractsByNetwork = {} } = {}) {
  if (!input || typeof input !== 'object') return { valid: false, reason: 'invalid-transfer-intent' }
  const { idempotencyKey, sponsorReference, network, purpose, asset, tokenContract = null, receiverAddress, amountBaseUnits } = input
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,160}$/.test(idempotencyKey)) {
    return { valid: false, reason: 'invalid-idempotency-key' }
  }
  if (typeof sponsorReference !== 'string' || !sponsorReference.trim() || sponsorReference.length > 128) {
    return { valid: false, reason: 'invalid-sponsor-reference' }
  }
  if (!NETWORKS.has(network)) return { valid: false, reason: 'invalid-network' }
  if (!PURPOSES.has(purpose)) return { valid: false, reason: 'invalid-purpose' }
  if (!ASSETS.has(asset)) return { valid: false, reason: 'invalid-asset' }
  if (purpose === 'network-fee' && asset !== 'TRX') return { valid: false, reason: 'network-fee-must-use-trx' }
  if (asset === 'TRX' && tokenContract) return { valid: false, reason: 'native-trx-has-no-token-contract' }
  if (TOKEN_ASSETS.has(asset) && (typeof tokenContract !== 'string' || !tokenContract.trim())) {
    return { valid: false, reason: 'token-contract-required' }
  }
  // Fail closed: a token symbol/name is not proof of identity. The caller must
  // provide an explicitly configured allowlist for the selected network.
  if (TOKEN_ASSETS.has(asset)) {
    const allowed = allowedTokenContractsByNetwork[network]
    if (!Array.isArray(allowed) || !allowed.some((contract) => typeof contract === 'string' && contract.trim() === tokenContract.trim())) {
      return { valid: false, reason: 'token-contract-not-allowlisted-for-network' }
    }
  }
  if (typeof isValidAddress !== 'function' || !isValidAddress(receiverAddress)) {
    return { valid: false, reason: 'invalid-receiver-address' }
  }
  const amount = baseUnits(amountBaseUnits)
  if (amount === null) return { valid: false, reason: 'invalid-base-units' }
  const max = maxTransferBaseUnits === undefined ? null : baseUnits(maxTransferBaseUnits)
  if (maxTransferBaseUnits !== undefined && (max === null || amount > max)) {
    return { valid: false, reason: 'transfer-limit-exceeded' }
  }
  return {
    valid: true,
    intent: {
      idempotencyKey,
      sponsorReference: sponsorReference.trim(),
      network,
      purpose,
      asset,
      tokenContract: TOKEN_ASSETS.has(asset) ? tokenContract.trim() : null,
      receiverAddress: receiverAddress.trim(),
      amountBaseUnits: amount.toString(),
    },
    authorizationRequired: true,
    atomicBudgetReservationRequired: true,
    providerSubmissionAllowed: false,
  }
}
