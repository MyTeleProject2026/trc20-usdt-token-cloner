import { timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import { TronWeb } from 'tronweb'
import { tatumProviderFetch } from '../tatum-provider-fetch.mjs'
import { getSponsorTransferForSubmission, transitionSponsorTransfer } from '../database.mjs'
import {
  listSponsorChainFeeObservations,
  recordSponsorChainFeeObservation,
} from '../sponsor-chain-fee-observations.mjs'
import { isValidTronAddress } from '../tron-address.mjs'
import { verifySolidifiedTrc20Transfer } from '../tron-verification.mjs'

const HOSTS = Object.freeze({
  nile: 'https://tron-nile.gateway.tatum.io',
  shasta: 'https://tron-shasta.gateway.tatum.io',
})
const TXID = /^[0-9a-f]{64}$/i
const KEY = /^[A-Za-z0-9._:-]{24,160}$/
const POSITIVE = /^[1-9][0-9]{0,77}$/
const UINT = /^(0|[1-9][0-9]{0,77})$/

function authorized(req, env) {
  const expected = env.SPONSOR_ADMIN_API_TOKEN
  const header = req.headers?.authorization
  if (typeof expected !== 'string' || expected.length < 32
    || typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const supplied = Buffer.from(header.slice(7))
  const actual = Buffer.from(expected)
  return supplied.length === actual.length && timingSafeEqual(supplied, actual)
}

function hexAddress(value) {
  if (typeof value !== 'string') return null
  const hex = value.replace(/^0x/i, '').toLowerCase()
  if (/^41[0-9a-f]{40}$/.test(hex)) return hex.slice(2)
  return /^[0-9a-f]{40}$/.test(hex) ? hex : null
}

function encodeAddress(tronWeb, value) {
  if (!isValidTronAddress(value) || !tronWeb.isAddress(value)) return null
  return hexAddress(tronWeb.address.toHex(value))
}

function uintString(value) {
  if (typeof value === 'string' && UINT.test(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  return null
}

function executionResult(transaction, info) {
  const receiptResult = String(info?.receipt?.result || '').toUpperCase()
  const infoResult = String(info?.result || '').toUpperCase()
  const ret = Array.isArray(transaction?.ret) ? transaction.ret : []
  if (['FAILED', 'OUT_OF_ENERGY', 'REVERT', 'ILLEGAL_OPERATION', 'OUT_OF_TIME'].includes(receiptResult)
    || infoResult === 'FAILED'
    || ret.some((item) => item?.contractRet && item.contractRet !== 'SUCCESS')) return 'FAILED'
  if (receiptResult === 'SUCCESS' || infoResult === 'SUCCESS'
    || ret.some((item) => item?.contractRet === 'SUCCESS')) return 'SUCCESS'
  return null
}

function matchesIntendedCall({ transaction, transfer, ownerHex, receiverHex, contractHex }) {
  const contracts = transaction?.raw_data?.contract
  if (!Array.isArray(contracts) || contracts.length !== 1) return false
  const item = contracts[0]
  const value = item?.parameter?.value
  if (hexAddress(value?.owner_address) !== ownerHex) return false
  if (transfer.asset === 'TRX') {
    return item.type === 'TransferContract'
      && hexAddress(value?.to_address) === receiverHex
      && uintString(value?.amount) === transfer.amountBaseUnits
  }
  if (item.type !== 'TriggerSmartContract'
    || hexAddress(value?.contract_address) !== contractHex
    || typeof value?.data !== 'string') return false
  const data = value.data.replace(/^0x/i, '').toLowerCase()
  if (!/^[0-9a-f]{136}$/.test(data) || data.slice(0, 8) !== 'a9059cbb') return false
  const encodedReceiver = data.slice(8, 72)
  const encodedAmount = data.slice(72, 136)
  return encodedReceiver.slice(0, 24) === '0'.repeat(24)
    && encodedReceiver.slice(24) === receiverHex
    && BigInt('0x' + encodedAmount).toString() === transfer.amountBaseUnits
}

/**
 * Read only finalized transaction and receipt data. Both successful and failed
 * execution outcomes are accepted only when the stored sponsor transfer's
 * exact transaction intent is proven from its on-chain transaction body.
 */
export async function readSolidifiedSponsorChainFeeEvidence({
  transfer, env = process.env, fetchImpl = tatumProviderFetch,
  tronWebFactory = (host) => new TronWeb({ fullHost: host }), timeoutMs = 8000,
} = {}) {
  const host = HOSTS[transfer?.network]
  const hash = typeof transfer?.transactionHash === 'string' ? transfer.transactionHash.toLowerCase() : ''
  if (!host || !TXID.test(hash)) return { success: false, reason: 'invalid-stored-transfer-identity' }
  if (typeof env.TATUM_API_KEY !== 'string' || !env.TATUM_API_KEY.trim()) return { success: false, reason: 'provider-credentials-missing' }
  if (transfer.purpose !== 'asset-grant' || !['TRX', 'USDT'].includes(transfer.asset)
    || !isValidTronAddress(transfer.sponsorAddress) || !isValidTronAddress(transfer.receiverAddress)
    || !POSITIVE.test(String(transfer.amountBaseUnits || ''))
    || (transfer.asset === 'TRX' ? transfer.tokenContract != null : !isValidTronAddress(transfer.tokenContract))) {
    return { success: false, reason: 'stored-transfer-identity-invalid' }
  }
  try {
    const tronWeb = await tronWebFactory(host)
    const ownerHex = encodeAddress(tronWeb, transfer.sponsorAddress)
    const receiverHex = encodeAddress(tronWeb, transfer.receiverAddress)
    const contractHex = transfer.asset === 'USDT' ? encodeAddress(tronWeb, transfer.tokenContract) : null
    if (!ownerHex || !receiverHex || (transfer.asset === 'USDT' && !contractHex)) {
      return { success: false, reason: 'stored-transfer-address-invalid' }
    }
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
      query('/walletsolidity/gettransactionbyid'),
      query('/walletsolidity/gettransactioninfobyid'),
    ])
    if (!txResult.success) return txResult
    if (!infoResult.success) return infoResult
    const transaction = txResult.payload
    const info = infoResult.payload
    const blockNumber = Number(info.blockNumber)
    if (String(transaction.txID || '').toLowerCase() !== hash || String(info.id || '').toLowerCase() !== hash
      || !Number.isSafeInteger(blockNumber) || blockNumber <= 0) {
      return { success: false, pending: true, reason: 'awaiting-solidified-transaction-and-receipt' }
    }
    if (!matchesIntendedCall({ transaction, transfer, ownerHex, receiverHex, contractHex })) {
      return { success: false, reason: 'solidified-transaction-intent-mismatch' }
    }
    const outcome = executionResult(transaction, info)
    if (!outcome) return { success: false, reason: 'solidified-execution-outcome-unknown' }
    if (outcome === 'SUCCESS') {
      if (transfer.asset === 'TRX') {
        const ret = Array.isArray(transaction.ret) ? transaction.ret : []
        if (!ret.some((row) => row?.contractRet === 'SUCCESS')) {
          return { success: false, reason: 'successful-native-transfer-receipt-missing' }
        }
      } else {
        const verified = verifySolidifiedTrc20Transfer({
          transaction, receipt: info, expectedTxId: hash,
          tokenContractAddress: tronWeb.address.toHex(transfer.tokenContract),
          fromAddress: tronWeb.address.toHex(transfer.sponsorAddress),
          toAddress: tronWeb.address.toHex(transfer.receiverAddress),
          amountSun: transfer.amountBaseUnits,
        })
        if (verified.verified !== true) return { success: false, reason: verified.reason || 'successful-token-transfer-event-missing' }
      }
    }

    const receipt = info.receipt && typeof info.receipt === 'object' ? info.receipt : {}
    const reportedFeeSun = uintString(info.fee ?? receipt.fee)
    if (reportedFeeSun === null) return { success: false, reason: 'solidified-receipt-fee-missing' }
    const fields = {
      energyFeeSun: receipt.energy_fee,
      netFeeSun: receipt.net_fee,
      energyUsageTotal: receipt.energy_usage_total,
      energyUsage: receipt.energy_usage,
      originEnergyUsage: receipt.origin_energy_usage,
      netUsage: receipt.net_usage,
      energyPenaltyTotal: receipt.energy_penalty_total,
    }
    const parsed = {}
    for (const [key, value] of Object.entries(fields)) {
      parsed[key] = value === undefined || value === null ? null : uintString(value)
      if (value !== undefined && value !== null && parsed[key] === null) {
        return { success: false, reason: 'invalid-solidified-fee-fields' }
      }
    }
    const transactionOwnerAddressHex = hexAddress(transaction.raw_data.contract[0].parameter.value.owner_address)
    if (transactionOwnerAddressHex !== ownerHex) return { success: false, reason: 'transaction-owner-mismatch' }
    return {
      success: true, network: transfer.network, transactionHash: hash, blockNumber,
      executionResult: outcome, transactionOwnerAddressHex,
      trxFeePayerAddressHex: BigInt(reportedFeeSun) > 0n ? transactionOwnerAddressHex : null,
      reportedFeeSun, ...parsed,
      evidenceSource: 'Tatum TRON SolidityNode transaction body and receipt',
    }
  } catch {
    return { success: false, reason: 'solidified-fee-evidence-read-failed' }
  }
}

export function createSponsorChainFeeObservationRouter(options = {}) {
  const env = options.env ?? process.env
  const lookup = options.lookupTransfer ?? getSponsorTransferForSubmission
  const readEvidence = options.readEvidence ?? ((transfer) => readSolidifiedSponsorChainFeeEvidence({
    transfer, env, fetchImpl: options.fetchImpl, tronWebFactory: options.tronWebFactory,
  }))
  const persist = options.persistObservation ?? recordSponsorChainFeeObservation
  const list = options.listObservations ?? listSponsorChainFeeObservations
  const router = Router()
  const fail = (res, status, error, extra = {}) => res.status(status).json({
    success: false, error, canSubmitSponsoredTransfer: false,
    feeSponsorBudgetSettled: false, sponsorFeeBudgetSettled: false, ...extra,
  })

  router.post('/sponsorship/transfers/:idempotencyKey/observe-chain-fees', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Vary', 'Authorization')
    if (typeof env.SPONSOR_ADMIN_API_TOKEN !== 'string' || env.SPONSOR_ADMIN_API_TOKEN.length < 32) return fail(res, 503, 'sponsor-admin-not-configured')
    if (!authorized(req, env)) return fail(res, 401, 'unauthorized')
    const key = req.params?.idempotencyKey
    if (typeof key !== 'string' || !KEY.test(key)) return fail(res, 400, 'invalid-idempotency-key')
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).length) return fail(res, 400, 'unexpected-fields', {
      message: 'Transaction IDs, fee amounts, addresses and execution results are read from the stored transfer and solidified chain only.',
    })
    try {
      const found = await lookup(key)
      if (found?.success !== true || !found.transfer) {
        const reason = found?.reason || 'sponsor-transfer-unavailable'
        return fail(res, reason === 'transfer-not-found' ? 404 : 503, reason)
      }
      const transfer = found.transfer
      if (!['nile', 'shasta'].includes(transfer.network) || transfer.purpose !== 'asset-grant'
        || !['TRX', 'USDT'].includes(transfer.asset) || !TXID.test(String(transfer.transactionHash || ''))) {
        return fail(res, 409, 'submitted-testnet-asset-transfer-required')
      }
      if (!['submitted', 'confirmed'].includes(transfer.status)) {
        return fail(res, 409, 'submitted-transfer-required', { status: transfer.status })
      }
      const evidence = await readEvidence(transfer)
      if (evidence?.success !== true) {
        return fail(res, evidence?.pending ? 202 : 503, evidence?.reason || 'solidified-fee-evidence-unavailable', {
          status: evidence?.pending ? 'awaiting-solidification' : 'fee-evidence-unavailable',
          network: transfer.network, transactionHash: transfer.transactionHash,
          retrySameTransaction: true,
        })
      }
      if (evidence.network !== transfer.network
        || evidence.transactionHash?.toLowerCase() !== transfer.transactionHash.toLowerCase()
        || !Number.isSafeInteger(evidence.blockNumber) || evidence.blockNumber <= 0
        || !['SUCCESS', 'FAILED'].includes(evidence.executionResult)) {
        return fail(res, 409, 'solidified-fee-evidence-identity-mismatch')
      }
      const stored = await persist({
        network: transfer.network, transactionHash: evidence.transactionHash,
        idempotencyKey: key, blockNumber: evidence.blockNumber,
        executionResult: evidence.executionResult,
        transactionOwnerAddressHex: evidence.transactionOwnerAddressHex,
        trxFeePayerAddressHex: evidence.trxFeePayerAddressHex,
        reportedFeeSun: evidence.reportedFeeSun,
        energyFeeSun: evidence.energyFeeSun, netFeeSun: evidence.netFeeSun,
        energyUsageTotal: evidence.energyUsageTotal, energyUsage: evidence.energyUsage,
        originEnergyUsage: evidence.originEnergyUsage, netUsage: evidence.netUsage,
        energyPenaltyTotal: evidence.energyPenaltyTotal,
      })
      if (stored?.success !== true) {
        const reason = stored?.reason || 'fee-observation-persistence-failed'
        return fail(res, reason === 'chain-fee-observation-conflict' ? 409 : 503, reason)
      }
      return res.status(200).json({
        success: true, status: 'solidified-chain-fee-observed-not-settled',
        duplicate: stored.duplicate === true, network: transfer.network,
        transactionHash: evidence.transactionHash, blockNumber: evidence.blockNumber,
        executionResult: evidence.executionResult,
        observedCosts: {
          reportedFeeSun: evidence.reportedFeeSun, energyFeeSun: evidence.energyFeeSun,
          netFeeSun: evidence.netFeeSun, energyUsageTotal: evidence.energyUsageTotal,
          energyUsage: evidence.energyUsage, originEnergyUsage: evidence.originEnergyUsage,
          netUsage: evidence.netUsage, energyPenaltyTotal: evidence.energyPenaltyTotal,
          transactionOwnerAddressHex: evidence.transactionOwnerAddressHex,
          trxFeePayerAddressHex: evidence.trxFeePayerAddressHex,
        },
        persistence: 'postgresql-project-sponsor-chain-fee-observations',
        feeSponsorDebitVerified: false, sponsorFeeBudgetSettled: false,
        feeSponsorBudgetSettled: false, canSubmitSponsoredTransfer: false,
        note: evidence.executionResult === 'FAILED'
          ? 'The failed execution fee is observed separately. The asset-principal transfer remains unchanged and its reservation is not confirmed or released.'
          : 'This is a fee-only observation. Transaction-owner attribution does not prove a separate sponsor debit; delegated resource consumption remains unattributed.',
      })
    } catch {
      return fail(res, 503, 'solidified-fee-observation-unavailable')
    }
  })

  router.post('/sponsorship/transfers/:idempotencyKey/reconcile-failed', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Vary', 'Authorization')
    if (typeof env.SPONSOR_ADMIN_API_TOKEN !== 'string' || env.SPONSOR_ADMIN_API_TOKEN.length < 32) return fail(res, 503, 'sponsor-admin-not-configured')
    if (!authorized(req, env)) return fail(res, 401, 'unauthorized')
    const key = req.params?.idempotencyKey
    if (typeof key !== 'string' || !KEY.test(key)) return fail(res, 400, 'invalid-idempotency-key')
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).length) return fail(res, 400, 'unexpected-fields')
    try {
      const found = await lookup(key)
      if (found?.success !== true || !found.transfer) {
        const reason = found?.reason || 'sponsor-transfer-unavailable'
        return fail(res, reason === 'transfer-not-found' ? 404 : 503, reason)
      }
      const transfer = found.transfer
      if (!['nile', 'shasta'].includes(transfer.network) || transfer.purpose !== 'asset-grant'
        || !['TRX', 'USDT'].includes(transfer.asset) || !TXID.test(String(transfer.transactionHash || ''))) {
        return fail(res, 409, 'submitted-testnet-asset-transfer-required')
      }
      if (transfer.status !== 'submitted') return fail(res, 409, 'submitted-transfer-required', { status: transfer.status })
      const changed = await transitionSponsorTransfer({
        idempotencyKey: key, nextStatus: 'failed',
        transactionHash: transfer.transactionHash.toLowerCase(),
      })
      if (changed?.updated !== true) {
        const reason = changed?.reason || 'failed-principal-reconciliation-rejected'
        return fail(res, reason === 'finalized-failure-fee-observation-required' ? 409 : 503, reason, {
          status: transfer.status, transactionHash: transfer.transactionHash,
          principalReservationReleased: false,
        })
      }
      return res.json({
        success: true, status: 'failed', network: transfer.network,
        transactionHash: transfer.transactionHash,
        principalReservationReleased: true,
        failureEvidence: 'matching-immutable-solidified-failed-fee-observation',
        feeBudgetSettled: false, sponsorFeeBudgetSettled: false,
        canSubmitSponsoredTransfer: false,
        note: 'The stored testnet principal reservation was released only after the database matched an immutable FAILED receipt observation to this exact transfer. This does not settle any fee sponsor budget.',
      })
    } catch {
      return fail(res, 503, 'failed-principal-reconciliation-unavailable', {
        principalReservationReleased: false,
      })
    }
  })

  router.get('/sponsorship/chain-fee-observations', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Vary', 'Authorization')
    if (typeof env.SPONSOR_ADMIN_API_TOKEN !== 'string' || env.SPONSOR_ADMIN_API_TOKEN.length < 32) return fail(res, 503, 'sponsor-admin-not-configured', { observations: [] })
    if (!authorized(req, env)) return fail(res, 401, 'unauthorized', { observations: [] })
    const network = req.query?.network === undefined ? null : req.query.network
    const limit = req.query?.limit === undefined ? 50 : Number(req.query.limit)
    if (network !== null && !['nile', 'shasta'].includes(network)) return fail(res, 400, 'invalid-network', { observations: [] })
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail(res, 400, 'invalid-limit', { observations: [] })
    const result = await list({ network, limit })
    if (result?.success !== true) return fail(res, 503, result?.reason || 'fee-observation-list-unavailable', { observations: [] })
    return res.json({
      success: true, status: 'sponsor-chain-fee-observations-read',
      count: result.observations.length, observations: result.observations,
      sponsorFeeBudgetSettled: false, canSubmitSponsoredTransfer: false,
    })
  })
  return router
}

export default createSponsorChainFeeObservationRouter()
