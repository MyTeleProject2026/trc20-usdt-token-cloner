import { timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import { getSponsorTransferForSubmission } from '../database.mjs'
import {
  listSponsorChainFeeSettlements,
  settleSponsorChainFeeObservation,
} from '../sponsor-chain-fee-settlements.mjs'

const KEY = /^[A-Za-z0-9._:-]{24,160}$/
const TXID = /^[0-9a-f]{64}$/i
const NETWORKS = new Set(['nile', 'shasta'])

function authorized(req, env) {
  const expected = env.SPONSOR_ADMIN_API_TOKEN
  const header = req.headers?.authorization
  if (typeof expected !== 'string' || expected.length < 32
    || typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const supplied = Buffer.from(header.slice(7))
  const actual = Buffer.from(expected)
  return supplied.length === actual.length && timingSafeEqual(supplied, actual)
}

export function createSponsorChainFeeSettlementRouter(options = {}) {
  const env = options.env ?? process.env
  const lookup = options.lookupTransfer ?? getSponsorTransferForSubmission
  const settle = options.settleFee ?? settleSponsorChainFeeObservation
  const list = options.listSettlements ?? listSponsorChainFeeSettlements
  const router = Router()

  const fail = (res, status, error, extra = {}) => res.status(status).json({
    success: false,
    error,
    feeSponsorDebitVerified: false,
    sponsorFeeBudgetSettled: false,
    delegatedResourceSettlement: false,
    canSubmitSponsoredTransfer: false,
    ...extra,
  })

  router.post('/sponsorship/transfers/:idempotencyKey/settle-observed-fees', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Vary', 'Authorization')
    if (typeof env.SPONSOR_ADMIN_API_TOKEN !== 'string' || env.SPONSOR_ADMIN_API_TOKEN.length < 32) {
      return fail(res, 503, 'sponsor-admin-not-configured')
    }
    if (!authorized(req, env)) return fail(res, 401, 'unauthorized')

    const key = req.params?.idempotencyKey
    if (typeof key !== 'string' || !KEY.test(key)) return fail(res, 400, 'invalid-idempotency-key')
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).length) {
      return fail(res, 400, 'unexpected-fields', {
        message: 'Transaction identity, fee amount, payer, and execution outcome are taken only from the stored transfer and immutable receipt observation.',
      })
    }

    try {
      const found = await lookup(key)
      if (found?.success !== true || !found.transfer) {
        const reason = found?.reason || 'sponsor-transfer-unavailable'
        return fail(res, reason === 'transfer-not-found' ? 404 : 503, reason)
      }
      const transfer = found.transfer
      if (!NETWORKS.has(transfer.network)
        || transfer.purpose !== 'asset-grant'
        || !['TRX', 'USDT'].includes(transfer.asset)
        || typeof transfer.transactionHash !== 'string'
        || !TXID.test(transfer.transactionHash)) {
        return fail(res, 409, 'stored-testnet-asset-transfer-required')
      }
      if (!['submitted', 'confirmed', 'failed'].includes(transfer.status)) {
        return fail(res, 409, 'submitted-transfer-required', { transferStatus: transfer.status })
      }

      const result = await settle({
        network: transfer.network,
        transactionHash: transfer.transactionHash.toLowerCase(),
        idempotencyKey: key,
      })
      if (result?.success !== true || result.settled !== true) {
        const reason = result?.reason || 'fee-settlement-unavailable'
        const conflict = [
          'invalid-fee-settlement-identity',
          'stored-submitted-transfer-identity-mismatch',
          'immutable-chain-fee-observation-required',
          'transaction-owner-and-fee-payer-evidence-mismatch',
          'no-trx-burn-to-settle',
          'network-fee-budget-not-found',
          'network-fee-sponsor-is-not-trx-burn-payer',
          'network-fee-budget-not-active',
          'network-fee-budget-approval-required',
          'insufficient-unreserved-network-fee-budget',
          'chain-fee-settlement-conflict',
        ].includes(reason)
        return fail(res, conflict ? 409 : 503, reason, {
          delegatedResourceSettlement: false,
          note: reason === 'network-fee-sponsor-is-not-trx-burn-payer'
            ? 'The configured network-fee budget wallet is not the transaction owner that paid the observed TRX burn. Delegated Energy/Bandwidth cannot be attributed to that sponsor from aggregate receipt fields, so no fee budget was debited.'
            : undefined,
        })
      }

      return res.status(200).json({
        success: true,
        status: 'solidified-direct-trx-burn-fee-settled',
        duplicate: result.duplicate === true,
        network: transfer.network,
        transactionHash: transfer.transactionHash.toLowerCase(),
        executionResult: result.executionResult,
        settlement: {
          reference: result.settlementReference,
          id: result.settlementId,
          settledFeeSun: result.settledFeeSun,
          feeBudgetSettled: true,
          feeSponsorDebitVerified: true,
          payerEvidence: 'immutable solidified receipt transaction owner equals the approved network-fee budget wallet',
          sameWalletAsAssetPrincipalSender: true,
          delegatedResourceSettlement: false,
        },
        submissionEnabled: false,
        canSubmitSponsoredTransfer: false,
        note: 'This narrowly settles only a positive TRX burn directly paid by the transaction-owner wallet, and only against that same approved network-fee budget. It does not settle a separate wallet’s delegated Energy/Bandwidth contribution and does not enable transfer submission.',
      })
    } catch {
      return fail(res, 503, 'sponsor-chain-fee-settlement-unavailable')
    }
  })

  router.get('/sponsorship/chain-fee-settlements', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Vary', 'Authorization')
    if (typeof env.SPONSOR_ADMIN_API_TOKEN !== 'string' || env.SPONSOR_ADMIN_API_TOKEN.length < 32) {
      return fail(res, 503, 'sponsor-admin-not-configured', { settlements: [] })
    }
    if (!authorized(req, env)) return fail(res, 401, 'unauthorized', { settlements: [] })
    const network = req.query?.network === undefined ? null : req.query.network
    const limit = req.query?.limit === undefined ? 50 : Number(req.query.limit)
    if (network !== null && !NETWORKS.has(network)) return fail(res, 400, 'invalid-network', { settlements: [] })
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail(res, 400, 'invalid-limit', { settlements: [] })
    const result = await list({ network, limit })
    if (result?.success !== true) return fail(res, 503, result?.reason || 'fee-settlement-list-unavailable', { settlements: [] })
    return res.json({
      success: true,
      status: 'sponsor-chain-fee-settlements-read',
      count: result.settlements.length,
      settlements: result.settlements,
      feeBudgetSettled: true,
      delegatedResourceSettlement: false,
      canSubmitSponsoredTransfer: false,
    })
  })

  return router
}

export default createSponsorChainFeeSettlementRouter()
