import { tatumProviderFetch } from '../tatum-provider-fetch.mjs'
import { timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import { TronWeb } from 'tronweb'
import {
  finalizeSponsorTransferBroadcast, getSponsorTransferForSubmission, getSponsorResourcePreflightEvidence,
  recordNativeTransferVerification, recordSponsorChainCostObservation,
  recordSponsorResourceCostSettlementObservation, recordTransferVerification, transitionSponsorTransfer,
} from '../database.mjs'
import { isValidTronAddress } from '../tron-address.mjs'
import { verifySolidifiedTrc20Transfer } from '../tron-verification.mjs'
import { readSolidifiedSponsorChainCosts } from './sponsor-chain-cost-observations.mjs'
import { verifySponsorFeeResourceSource } from '../sponsor-tron-submission.mjs'
import { createSponsorDelegationHistoryVerifier } from '../sponsor-delegation-history.mjs'

const HOSTS = Object.freeze({
  nile: 'https://tron-nile.gateway.tatum.io',
  shasta: 'https://tron-shasta.gateway.tatum.io',
})
const TXID = /^[0-9a-f]{64}$/i
const POSITIVE = /^[1-9][0-9]{0,77}$/

function authorized(req, env) {
  const expected = env.SPONSOR_ADMIN_API_TOKEN
  const value = req.headers?.authorization
  if (typeof expected !== 'string' || expected.length < 32 || typeof value !== 'string' || !value.startsWith('Bearer ')) return false
  const a = Buffer.from(value.slice(7))
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
function normalizeHex(value) {
  if (typeof value !== 'string') return null
  const hex = value.replace(/^0x/i, '').toLowerCase()
  return /^41[0-9a-f]{40}$/.test(hex) ? hex.slice(2) : /^[0-9a-f]{40}$/.test(hex) ? hex : null
}
function encodedAddress(tronWeb, address) {
  if (!isValidTronAddress(address) || !tronWeb.isAddress(address)) return null
  const hex = String(tronWeb.address.toHex(address) || '').replace(/^0x/i, '').toLowerCase()
  return /^41[0-9a-f]{40}$/.test(hex) ? hex : null
}
function amountString(value) {
  if (typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  return null
}

/** Verify a stored testnet transfer with its exact SolidityNode transaction + receipt. */
export async function readSolidifiedSponsorTransferEvidence({
  transfer, env = process.env, fetchImpl = tatumProviderFetch,
  tronWebFactory = (host) => new TronWeb({ fullHost: host }), timeoutMs = 8000,
} = {}) {
  const host = HOSTS[transfer?.network]
  const hash = typeof transfer?.transactionHash === 'string' ? transfer.transactionHash.toLowerCase() : ''
  if (!host || !TXID.test(hash)) return { success: false, reason: 'invalid-stored-transfer-identity' }
  if (typeof env.TATUM_API_KEY !== 'string' || !env.TATUM_API_KEY.trim()) return { success: false, reason: 'provider-credentials-missing' }
  if (!['TRX', 'USDT'].includes(transfer.asset)
    || !isValidTronAddress(transfer.sponsorAddress) || !isValidTronAddress(transfer.receiverAddress)
    || !POSITIVE.test(String(transfer.amountBaseUnits || ''))
    || (transfer.asset === 'TRX' ? transfer.tokenContract != null : !isValidTronAddress(transfer.tokenContract))) {
    return { success: false, reason: 'stored-transfer-identity-invalid' }
  }
  try {
    const tronWeb = await tronWebFactory(host)
    const fromHex = encodedAddress(tronWeb, transfer.sponsorAddress)
    const toHex = encodedAddress(tronWeb, transfer.receiverAddress)
    const tokenHex = transfer.asset === 'TRX' ? null : encodedAddress(tronWeb, transfer.tokenContract)
    if (!fromHex || !toHex || (transfer.asset !== 'TRX' && !tokenHex)) return { success: false, reason: 'stored-transfer-address-invalid' }
    const query = async (path) => {
      const response = await fetchImpl(host + path, {
        method: 'POST', redirect: 'error',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'x-api-key': env.TATUM_API_KEY.trim() },
        body: JSON.stringify({ value: hash, visible: false }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) return { success: false, reason: 'provider-http-error', providerStatus: response.status }
      const payload = await response.json()
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.Error) return { success: false, reason: 'invalid-provider-response' }
      return { success: true, payload }
    }
    const [txResult, infoResult] = await Promise.all([
      query('/walletsolidity/gettransactionbyid'), query('/walletsolidity/gettransactioninfobyid'),
    ])
    if (!txResult.success) return txResult
    if (!infoResult.success) return infoResult
    const tx = txResult.payload
    const info = infoResult.payload
    const blockNumber = Number(info.blockNumber)
    if (String(tx.txID || '').toLowerCase() !== hash || String(info.id || '').toLowerCase() !== hash
      || !Number.isSafeInteger(blockNumber) || blockNumber <= 0) {
      return { success: false, pending: true, reason: 'awaiting-solidified-transaction-and-receipt' }
    }
    const ret = Array.isArray(tx.ret) ? tx.ret : []
    if (ret.some((row) => row?.contractRet && row.contractRet !== 'SUCCESS')
      || String(info.result || '').toUpperCase() === 'FAILED'
      || ['FAILED','OUT_OF_ENERGY'].includes(String(info.receipt?.result || '').toUpperCase())) {
      return { success: false, reason: 'solidified-transaction-execution-failed' }
    }
    const common = {
      success: true, status: 'solidified-transfer-verified', network: transfer.network,
      transactionHash: hash, blockNumber, executionResult: 'SUCCESS',
      asset: transfer.asset, tokenContract: transfer.tokenContract ?? null,
      fromAddress: transfer.sponsorAddress, toAddress: transfer.receiverAddress,
      amountBaseUnits: transfer.amountBaseUnits,
      evidenceSource: 'TRON SolidityNode transaction body and receipt',
    }
    if (transfer.asset === 'TRX') {
      const list = tx?.raw_data?.contract
      const item = Array.isArray(list) && list.length === 1 && list[0]?.type === 'TransferContract' ? list[0] : null
      const value = item?.parameter?.value
      if (!item || !ret.some((row) => row?.contractRet === 'SUCCESS')
        || normalizeHex(value?.owner_address) !== normalizeHex(fromHex)
        || normalizeHex(value?.to_address) !== normalizeHex(toHex)
        || amountString(value?.amount) !== transfer.amountBaseUnits) {
        return { success: false, reason: 'solidified-native-transfer-identity-mismatch' }
      }
      return common
    }
    const tokenResult = verifySolidifiedTrc20Transfer({
      transaction: tx, receipt: info, expectedTxId: hash,
      tokenContractAddress: tokenHex, fromAddress: fromHex,
      toAddress: toHex, amountSun: transfer.amountBaseUnits,
    })
    if (tokenResult.verified !== true) return { success: false, reason: tokenResult.reason || 'solidified-token-transfer-identity-mismatch' }
    return { ...common, logIndex: tokenResult.logIndex }
  } catch {
    return { success: false, reason: 'solidified-chain-verification-unavailable' }
  }
}

/**
 * Admin-triggered reconciliation that derives all transaction identity from the
 * stored intent, independently reads solidified chain data, persists evidence,
 * confirms the principal reservation, and optionally records receipt-cost facts.
 */
export function createSponsorSolidifiedReconciliationRouter(options = {}) {
  const env = options.env ?? process.env
  const lookup = options.lookupTransfer ?? getSponsorTransferForSubmission
  const readEvidence = options.readEvidence ?? ((transfer) => readSolidifiedSponsorTransferEvidence({
    transfer, env, fetchImpl: options.fetchImpl, tronWebFactory: options.tronWebFactory,
  }))
  const persistNative = options.persistNative ?? recordNativeTransferVerification
  const persistToken = options.persistToken ?? recordTransferVerification
  const confirm = options.confirmTransfer ?? transitionSponsorTransfer
  const finalize = options.finalizeBroadcast ?? finalizeSponsorTransferBroadcast
  const readCosts = options.readCosts ?? ((transfer) => readSolidifiedSponsorChainCosts({
    transfer, env, fetchImpl: options.fetchImpl, tronWebFactory: options.tronWebFactory,
  }))
  const persistCosts = options.persistCosts ?? recordSponsorChainCostObservation
  const readPreflightEvidence = options.readPreflightEvidence ?? getSponsorResourcePreflightEvidence
  const verifyHistory = options.verifyHistory ?? createSponsorDelegationHistoryVerifier({
    env,
    fetchImpl: options.fetchImpl,
    tronWebFactory: options.tronWebFactory,
  })
  const router = Router()
  router.post('/sponsorship/transfers/:idempotencyKey/reconcile-solidified', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Vary', 'Authorization')
    const fail = (code, error, extra = {}) => res.status(code).json({
      success: false, error, canSubmitSponsoredTransfer: false, transactionBroadcast: false,
      feeSponsorBudgetSettled: false, sponsorFeeBudgetSettled: false,
      userFundedFallbackAllowed: false, ...extra,
    })
    if (typeof env.SPONSOR_ADMIN_API_TOKEN !== 'string' || env.SPONSOR_ADMIN_API_TOKEN.length < 32) return fail(503, 'sponsor-admin-not-configured')
    if (!authorized(req, env)) return fail(401, 'unauthorized')
    const key = req.params?.idempotencyKey
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{24,160}$/.test(key)) return fail(400, 'invalid-idempotency-key')
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).length) return fail(400, 'unexpected-fields')

    try {
      const found = await lookup(key)
      if (found?.success !== true || !found.transfer) {
        const reason = found?.reason || 'sponsor-transfer-unavailable'
        return fail(reason === 'transfer-not-found' ? 404 : 503, reason)
      }
      const transfer = found.transfer
      if (!['nile','shasta'].includes(transfer.network) || transfer.purpose !== 'asset-grant'
        || !['TRX','USDT'].includes(transfer.asset) || !TXID.test(String(transfer.transactionHash || ''))) {
        return fail(409, 'submitted-testnet-asset-transfer-required', { network: transfer.network || null, status: transfer.status || null })
      }
      if (!['broadcasting','submitted','confirmed'].includes(transfer.status)) return fail(409, 'submitted-transfer-required', { status: transfer.status })
      const evidence = await readEvidence(transfer)
      if (evidence?.success !== true) {
        return fail(evidence?.pending ? 202 : 503, evidence?.reason || 'solidified-verification-unavailable', {
          status: evidence?.pending ? 'awaiting-solidification' : 'verification-unavailable',
          network: transfer.network, transactionHash: transfer.transactionHash,
          retrySameTransaction: true,
          message: evidence?.pending
            ? 'The saved transaction is not yet visible in solidified state. Retry reconciliation with the same idempotency key and transaction ID.'
            : 'Exact solidified-chain proof could not be verified. No principal ledger confirmation was performed.',
        })
      }
      if (evidence.network !== transfer.network || evidence.transactionHash?.toLowerCase() !== transfer.transactionHash.toLowerCase()
        || !Number.isSafeInteger(evidence.blockNumber) || evidence.blockNumber <= 0
        || evidence.executionResult !== 'SUCCESS' || evidence.fromAddress !== transfer.sponsorAddress
        || evidence.toAddress !== transfer.receiverAddress || evidence.amountBaseUnits !== transfer.amountBaseUnits
        || evidence.asset !== transfer.asset || (evidence.tokenContract || null) !== (transfer.tokenContract || null)) {
        return fail(409, 'solidified-evidence-identity-mismatch', { transactionHash: transfer.transactionHash })
      }
      const persist = transfer.asset === 'TRX'
        ? await persistNative({
            network: transfer.network, transactionHash: transfer.transactionHash,
            fromAddress: transfer.sponsorAddress, toAddress: transfer.receiverAddress,
            amountSun: transfer.amountBaseUnits, blockNumber: evidence.blockNumber,
          })
        : await persistToken({
            network: transfer.network, transactionHash: transfer.transactionHash,
            tokenContract: transfer.tokenContract, fromAddress: transfer.sponsorAddress,
            toAddress: transfer.receiverAddress, amountBaseUnits: transfer.amountBaseUnits,
            status: 'verified-on-chain', logIndex: evidence.logIndex,
            result: { verified: true, blockNumber: evidence.blockNumber, logIndex: evidence.logIndex, confirmationSource: evidence.evidenceSource },
          })
      if (persist?.persisted !== true) return fail(503, persist?.reason || 'solidified-evidence-persistence-failed', {
        network: transfer.network, transactionHash: transfer.transactionHash, blockNumber: evidence.blockNumber,
        message: 'The chain evidence was checked, but its database persistence failed; principal budget was not confirmed.',
      })

      if (transfer.status === 'broadcasting') {
        const finalized = await finalize({
          idempotencyKey: key, transactionHash: transfer.transactionHash,
          sponsorAddress: transfer.sponsorAddress,
        })
        if (finalized?.updated !== true) return fail(503, finalized?.reason || 'broadcast-ledger-finalization-pending', {
          evidencePersisted: true, network: transfer.network, transactionHash: transfer.transactionHash,
          message: 'Solidified evidence is persisted, but the stored broadcasting row could not be advanced. Retry reconciliation on this same transaction.',
        })
      }
      const settled = await confirm({ idempotencyKey: key, nextStatus: 'confirmed', transactionHash: transfer.transactionHash.toLowerCase() })
      if (settled?.updated !== true) return fail(503, settled?.reason || 'sponsor-principal-ledger-confirmation-failed', {
        evidencePersisted: true, network: transfer.network, transactionHash: transfer.transactionHash,
        message: 'Solidified evidence is persisted, but the principal sponsor reservation was not confirmed.',
      })

      const feeAddress = typeof env['SPONSOR_FEE_' + transfer.network.toUpperCase() + '_ADDRESS'] === 'string'
        ? env['SPONSOR_FEE_' + transfer.network.toUpperCase() + '_ADDRESS'].trim() : ''
      let costs = { status: 'not-attempted', reason: 'distinct-fee-sponsor-address-not-configured', sponsorFeeBudgetSettled: false }
      if (isValidTronAddress(feeAddress) && feeAddress !== transfer.sponsorAddress) {
        try {
          const observed = await readCosts(transfer)
          if (observed?.success === true && observed.network === transfer.network
            && observed.transactionHash?.toLowerCase() === transfer.transactionHash.toLowerCase()
            && observed.executionResult === 'SUCCESS' && observed.blockNumber === evidence.blockNumber
            && Number.isSafeInteger(observed.blockTimestampMs) && observed.blockTimestampMs > 0) {
            const stored = await persistCosts({
              network: transfer.network, transactionHash: transfer.transactionHash.toLowerCase(),
              idempotencyKey: key, sponsorReference: transfer.sponsorReference, feeSponsorAddress: feeAddress,
              assetPrincipalAddress: transfer.sponsorAddress, receiverAddress: transfer.receiverAddress,
              asset: transfer.asset, tokenContract: transfer.tokenContract ?? null,
              amountBaseUnits: transfer.amountBaseUnits, blockNumber: observed.blockNumber,
              blockTimestampMs: observed.blockTimestampMs,
              executionResult: 'SUCCESS', reportedFeeSun: observed.reportedFeeSun,
              energyFeeSun: observed.energyFeeSun, netFeeSun: observed.netFeeSun,
              energyUsageTotal: observed.energyUsageTotal, energyUsage: observed.energyUsage,
              netUsage: observed.netUsage, energyPenaltyTotal: observed.energyPenaltyTotal,
            })
            if (stored?.success === true) {
              const currentSourceEvidence = await verifySponsorFeeResourceSource({ transfer, env })
              const preflight = await readPreflightEvidence(key)
              const historicalProof = preflight?.success === true
                ? await verifyHistory({
                    transfer,
                    preflightEvidence: preflight.preflightEvidence,
                    transactionHash: transfer.transactionHash.toLowerCase(),
                    blockNumber: observed.blockNumber,
                    blockTimestampMs: observed.blockTimestampMs,
                  })
                : { success: false, reason: preflight?.reason || 'resource-preflight-evidence-unavailable' }
              const attributionEvidence = currentSourceEvidence?.success === true
                ? {
                    ...currentSourceEvidence,
                    historicalDelegationStateVerified: historicalProof?.success === true,
                    historicalDelegationProof: historicalProof?.success === true ? historicalProof : null,
                    historicalDelegationProofReason: historicalProof?.success === true
                      ? null : historicalProof?.reason || 'historical-delegation-proof-unavailable',
                  }
                : currentSourceEvidence
              const resourceObservation = await recordSponsorResourceCostSettlementObservation({
                idempotencyKey: key,
                transactionHash: transfer.transactionHash.toLowerCase(),
                attributionEvidence,
              })
              costs = {
                status: resourceObservation?.sponsorResourceBudgetSettled === true
                  ? 'solidified-resource-budget-settled'
                  : resourceObservation?.status === 'manual-review'
                    ? 'solidified-resource-cost-manual-review'
                    : 'solidified-costs-observed-pending-resource-attribution',
                duplicate: stored.duplicate === true,
                reportedFeeSun: observed.reportedFeeSun,
                resourceCostObservation: resourceObservation?.success === true
                  ? {
                      status: resourceObservation.status,
                      duplicate: resourceObservation.duplicate === true,
                      sponsorResourceBudgetSettled: resourceObservation.sponsorResourceBudgetSettled === true,
                    }
                  : { status: 'not-recorded', reason: resourceObservation?.reason || 'resource-observation-unavailable' },
                sponsorResourceBudgetSettled: resourceObservation?.sponsorResourceBudgetSettled === true,
                sponsorFeeBudgetSettled: false,
              }
            } else {
              costs = { status: 'cost-observation-persistence-failed', reason: stored?.reason || 'persistence-failed', sponsorFeeBudgetSettled: false }
            }
          } else costs = { status: 'solidified-cost-observation-unavailable', reason: observed?.reason || 'cost-evidence-mismatch', sponsorFeeBudgetSettled: false }
        } catch { costs = { status: 'solidified-cost-observation-unavailable', reason: 'observation-unavailable', sponsorFeeBudgetSettled: false } }
      }
      return res.status(200).json({
        success: true, status: 'solidified-transfer-ledger-confirmed', duplicate: settled.duplicate === true,
        network: transfer.network, asset: transfer.asset, amountBaseUnits: transfer.amountBaseUnits,
        transactionHash: transfer.transactionHash.toLowerCase(), blockNumber: evidence.blockNumber, executionResult: 'SUCCESS',
        evidencePersistence: { persisted: true },
        principalLedger: { status: 'confirmed', principalSpendRecorded: settled.duplicate !== true, reservationReleased: settled.duplicate !== true },
        chainCostObservation: costs, feeSponsorBudgetSettled: false, sponsorFeeBudgetSettled: false,
        feeSponsorDebitVerified: false, canSubmitSponsoredTransfer: false, submissionEnabled: false,
        userFundedFallbackAllowed: false,
        note: 'The saved transfer is independently verified from solidified chain state and principal ledger confirmation is evidence-gated. Receipt cost observations do not prove the separate fee sponsor was debited or settle its resource budget; no exchange deposit credit is inferred.',
      })
    } catch {
      return fail(503, 'solidified-reconciliation-unavailable', {
        message: 'Reconciliation did not complete. Recheck the saved transaction and database state before retrying; do not send a substitute transaction.',
      })
    }
  })
  return router
}
export default createSponsorSolidifiedReconciliationRouter()
