import { TronWeb } from 'tronweb'
import { verifyTreasuryTransferEvidence } from './routes/treasury-withdrawals.mjs'
import { refreshSponsorOrganizationFireblocksPayout } from './sponsor-organization-fireblocks-submission.mjs'

const OFFICIAL_MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const MAINNET_RPC = 'https://api.trongrid.io'
const TXID_PATTERN = /^[0-9a-f]{64}$/i
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/

function readNonNegativeUnits(value) {
  if (typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  return null
}

function readPostgresBigint(value) {
  const units = readNonNegativeUnits(value)
  return units !== null && BigInt(units) <= 9_223_372_036_854_775_807n ? units : null
}

function verifiedSettlementResponse(context, extra = {}) {
  return {
    success: true,
    status: context.chainVerificationStatus,
    payoutOutcome: context.chainVerificationStatus,
    intentId: context.intentId,
    transactionHash: context.transactionHash,
    chainVerification: {
      status: context.chainVerificationStatus,
      reason: context.chainVerificationReason,
      blockNumber: context.chainVerificationBlockNumber,
      verifiedAt: context.chainVerifiedAt,
    },
    principalSettlementStatus: context.principalSettlementStatus,
    feeSettlementStatus: context.feeSettlementStatus,
    principalBudgetSettledOrReleased: context.principalSettlementStatus !== 'pending',
    feeReservationRetained: context.feeSettlementStatus === 'pending-resource-reconciliation'
      || context.feeSettlementStatus === 'over-cap-manual-review',
    observedFeeSun: context.observedFeeSun,
    observedEnergyUsage: context.observedEnergyUsage,
    observedNetUsage: context.observedNetUsage,
    canSubmitSponsoredTransfer: false,
    submissionEnabled: false,
    transactionSubmitted: false,
    userFundedFallbackAllowed: false,
    note: 'The exact solidified Mainnet USDT receipt/event has been verified. Only the principal budget was settled or released. The fee/resource budget remains reserved pending provider-specific TRX, Energy and Bandwidth cost reconciliation.',
    ...extra,
  }
}

/**
 * Independently verifies a Fireblocks-returned hash against TRON's confirmed
 * transaction, receipt and exact official-Tether Transfer event. It settles
 * only the principal budget. The fee/resource budget remains reserved until
 * delegated-resource consumption and any actual TRX burn can be reconciled.
 */
export async function verifyAndSettleSponsorOrganizationFireblocksPayout({
  store,
  intentId,
  env = process.env,
  refreshProviderStatus = refreshSponsorOrganizationFireblocksPayout,
  tronWebFactory = async () => new TronWeb({
    fullHost: MAINNET_RPC,
    ...(typeof env.TRONGRID_API_KEY === 'string' && env.TRONGRID_API_KEY.trim()
      ? { headers: { 'TRON-PRO-API-KEY': env.TRONGRID_API_KEY.trim() } } : {}),
  }),
  verifyTransferEvidence = verifyTreasuryTransferEvidence,
} = {}) {
  const fail = (reason, extra = {}) => ({
    success: false, reason, status: reason,
    canSubmitSponsoredTransfer: false, submissionEnabled: false,
    transactionSubmitted: false, userFundedFallbackAllowed: false, ...extra,
  })
  if (!store || typeof store.getFireblocksPayoutSettlementContext !== 'function'
    || typeof store.recordFireblocksPayoutChainVerification !== 'function'
    || typeof intentId !== 'string' || !/^[1-9][0-9]{0,17}$/.test(intentId)) {
    return fail('invalid-fireblocks-chain-settlement-request')
  }

  // A status refresh is idempotent and never creates a new provider request.
  let refreshed
  try { refreshed = await refreshProviderStatus({ store, intentId, env }) } catch {
    return fail('fireblocks-provider-refresh-unavailable')
  }
  if (refreshed?.success !== true) return fail(refreshed?.reason || 'fireblocks-provider-refresh-unavailable')

  let loaded
  try { loaded = await store.getFireblocksPayoutSettlementContext(intentId) } catch {
    return fail('fireblocks-chain-settlement-context-unavailable')
  }
  if (!loaded?.success || !loaded.context) return fail(loaded?.reason || 'fireblocks-chain-settlement-context-unavailable')
  const context = loaded.context
  if (context.network !== 'mainnet' || context.asset !== 'USDT'
    || context.tokenContract !== OFFICIAL_MAINNET_USDT
    || !ADDRESS_PATTERN.test(context.principalSponsorAddress || '')
    || !ADDRESS_PATTERN.test(context.receiverAddress || '')
    || !/^[1-9][0-9]{0,77}$/.test(context.amountBaseUnits || '')
    || !/^[1-9][0-9]{0,77}$/.test(context.feeCapSun || '')) {
    return fail('settlement-requires-official-mainnet-usdt-intent')
  }
  if (context.chainVerificationStatus === 'confirmed' || context.chainVerificationStatus === 'failed') {
    return verifiedSettlementResponse(context, { duplicate: true })
  }
  if (context.submissionStatus !== 'broadcast-accepted' || !TXID_PATTERN.test(context.transactionHash || '')) {
    return fail('provider-chain-transaction-hash-not-available', {
      providerStatus: context.providerStatus || null,
      submissionStatus: context.submissionStatus,
      reservationRetained: true,
    })
  }

  let tronWeb
  let transaction
  let transactionInfo
  try {
    tronWeb = await tronWebFactory(env)
    if (!tronWeb?.trx?.getConfirmedTransaction || !tronWeb?.trx?.getTransactionInfo) {
      return fail('tron-confirmed-node-client-unavailable')
    }
    [transaction, transactionInfo] = await Promise.all([
      tronWeb.trx.getConfirmedTransaction(context.transactionHash).catch(() => null),
      tronWeb.trx.getTransactionInfo(context.transactionHash).catch(() => null),
    ])
  } catch {
    return fail('tron-confirmed-receipt-read-unavailable', { reservationRetained: true })
  }

  let evidence
  try {
    evidence = verifyTransferEvidence(tronWeb, {
      transaction,
      transactionInfo,
      transactionHash: context.transactionHash,
      treasuryAddress: context.principalSponsorAddress,
      recipientAddress: context.receiverAddress,
      amountBaseUnits: context.amountBaseUnits,
    })
  } catch {
    return fail('solidified-usdt-transfer-verification-unavailable', { reservationRetained: true })
  }
  if (evidence?.verified !== true || !['confirmed', 'failed'].includes(evidence.status)) {
    return fail(evidence?.status || 'awaiting-confirmed-receipt', {
      verification: evidence || null,
      reservationRetained: true,
      note: 'No principal or fee budget is released from a transaction hash or provider status alone. Retry after the transaction is available from the confirmed node.',
    })
  }

  const blockNumber = Number(evidence.blockNumber)
  const feeSun = readNonNegativeUnits(transactionInfo?.fee)
  const energyUsage = readNonNegativeUnits(transactionInfo?.receipt?.energy_usage_total ?? transactionInfo?.receipt?.energy_usage)
  const netUsage = readPostgresBigint(transactionInfo?.receipt?.net_usage ?? transactionInfo?.net_usage)
  const saved = await store.recordFireblocksPayoutChainVerification({
    intentId,
    intentDigest: context.intentDigest,
    externalTxId: context.externalTxId,
    transactionHash: context.transactionHash,
    verificationStatus: evidence.status,
    verificationReason: evidence.reason,
    blockNumber,
    feeSun,
    energyUsage,
    netUsage,
  })
  if (!saved?.success) return fail(saved?.reason || 'fireblocks-chain-budget-settlement-failed', {
    verification: evidence, reservationRetained: true,
  })

  const refreshedContext = await store.getFireblocksPayoutSettlementContext(intentId)
  if (!refreshedContext?.success) return fail('fireblocks-settlement-result-readback-failed', {
    chainVerification: evidence, principalSettlement: saved, feeReservationRetained: true,
  })
  return verifiedSettlementResponse(refreshedContext.context, {
    duplicate: saved.duplicate === true,
    verification: evidence,
    feeReservationRetained: true,
  })
}

export default verifyAndSettleSponsorOrganizationFireblocksPayout