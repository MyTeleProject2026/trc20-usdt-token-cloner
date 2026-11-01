import { tatumProviderFetch } from '../tatum-provider-fetch.mjs'
import { timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import { TronWeb } from 'tronweb'
import {
  getSponsorTransferForSubmission,
  listSponsorChainCostObservations,
  recordSponsorChainCostObservation,
} from '../database.mjs'
import { isValidTronAddress } from '../tron-address.mjs'
import { verifySolidifiedTrc20Transfer } from '../tron-verification.mjs'

const NETWORKS = Object.freeze({
  shasta: 'https://tron-shasta.gateway.tatum.io',
  nile: 'https://tron-nile.gateway.tatum.io',
})
const TX_PATTERN = /^[0-9a-f]{64}$/i
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,77})$/

function adminAuthorized(req, env) {
  const expected = env.SPONSOR_ADMIN_API_TOKEN
  const header = req.headers?.authorization
  if (typeof expected !== 'string' || expected.length < 32
    || typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const supplied = Buffer.from(header.slice(7))
  const actual = Buffer.from(expected)
  return supplied.length === actual.length && timingSafeEqual(supplied, actual)
}

function safeIntegerString(value, { allowNull = false } = {}) {
  if ((value === undefined || value === null) && allowNull) return null
  if (typeof value === 'string' && AMOUNT_PATTERN.test(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  return null
}

function normalizeHexAddress(value) {
  if (typeof value !== 'string') return null
  const hex = value.replace(/^0x/i, '').toLowerCase()
  if (/^41[0-9a-f]{40}$/.test(hex)) return hex.slice(2)
  if (/^[0-9a-f]{40}$/.test(hex)) return hex
  return null
}

function valueAddressHex(tronWeb, address) {
  if (typeof address !== 'string' || !tronWeb.isAddress(address)) return null
  return normalizeHexAddress(tronWeb.address.toHex(address))
}

function isExecutionFailed(transaction, info) {
  if (String(info?.result || '').toUpperCase() === 'FAILED'
    || String(info?.receipt?.result || '').toUpperCase() === 'FAILED'
    || String(info?.receipt?.result || '').toUpperCase() === 'OUT_OF_ENERGY') return true
  const ret = Array.isArray(transaction?.ret) ? transaction.ret : []
  return ret.some((item) => item?.contractRet && item.contractRet !== 'SUCCESS')
}

/**
 * Query and validate transaction cost fields from the fixed selected network's
 * SolidityNode. No provider-supplied endpoint, address or transaction hash is
 * accepted from the HTTP caller.
 */
export async function readSolidifiedSponsorChainCosts({
  transfer,
  env = process.env,
  fetchImpl = tatumProviderFetch,
  tronWebFactory = (host) => new TronWeb({ fullHost: host }),
  timeoutMs = 8000,
} = {}) {
  const network = transfer?.network
  const host = NETWORKS[network]
  const hash = typeof transfer?.transactionHash === 'string' ? transfer.transactionHash.toLowerCase() : ''
  if (!host || !TX_PATTERN.test(hash)) return { success: false, reason: 'invalid-stored-transfer-identity' }
  if (typeof env.TATUM_API_KEY !== 'string' || !env.TATUM_API_KEY.trim()) {
    return { success: false, reason: 'provider-credentials-missing' }
  }
  if (typeof fetchImpl !== 'function') return { success: false, reason: 'provider-unavailable' }

  try {
    const tronWeb = await tronWebFactory(host)
    const principalHex = valueAddressHex(tronWeb, transfer.sponsorAddress)
    const receiverHex = valueAddressHex(tronWeb, transfer.receiverAddress)
    const contractHex = transfer.asset === 'TRX' ? null : valueAddressHex(tronWeb, transfer.tokenContract)
    if (!principalHex || !receiverHex || (transfer.asset !== 'TRX' && !contractHex)) {
      return { success: false, reason: 'stored-transfer-address-invalid' }
    }

    const query = async (path) => {
      const response = await fetchImpl(host + path, {
        method: 'POST',
        redirect: 'error',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-api-key': env.TATUM_API_KEY.trim(),
        },
        body: JSON.stringify({ value: hash, visible: false }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) return { success: false, reason: 'provider-http-error', providerStatus: response.status }
      const payload = await response.json()
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.Error) {
        return { success: false, reason: 'invalid-provider-response' }
      }
      return { success: true, payload }
    }
    const [transactionResult, infoResult] = await Promise.all([
      query('/walletsolidity/gettransactionbyid'),
      query('/walletsolidity/gettransactioninfobyid'),
    ])
    if (!transactionResult.success) return transactionResult
    if (!infoResult.success) return infoResult
    const transaction = transactionResult.payload
    const info = infoResult.payload
    const blockNumber = Number(info.blockNumber)
    const blockTimestampMs = Number(info.blockTimeStamp)
    if (String(transaction.txID || '').toLowerCase() !== hash
      || String(info.id || '').toLowerCase() !== hash
      || !Number.isSafeInteger(blockNumber) || blockNumber <= 0
      || !Number.isSafeInteger(blockTimestampMs) || blockTimestampMs <= 0) {
      return { success: false, reason: 'solidified-transaction-or-receipt-missing' }
    }
    if (isExecutionFailed(transaction, info)) {
      return { success: false, reason: 'solidified-transaction-execution-failed' }
    }

    if (transfer.asset === 'TRX') {
      const contracts = transaction?.raw_data?.contract
      const value = Array.isArray(contracts) && contracts.length === 1
        && contracts[0]?.type === 'TransferContract'
        ? contracts[0]?.parameter?.value : null
      const actualFrom = normalizeHexAddress(value?.owner_address)
      const actualTo = normalizeHexAddress(value?.to_address)
      const amount = safeIntegerString(value?.amount)
      if (!value || actualFrom !== principalHex || actualTo !== receiverHex
        || amount !== transfer.amountBaseUnits) {
        return { success: false, reason: 'solidified-native-transfer-identity-mismatch' }
      }
    } else {
      const verification = verifySolidifiedTrc20Transfer({
        transaction,
        receipt: info,
        expectedTxId: hash,
        tokenContractAddress: tronWeb.address.toHex(transfer.tokenContract),
        fromAddress: tronWeb.address.toHex(transfer.sponsorAddress),
        toAddress: tronWeb.address.toHex(transfer.receiverAddress),
        amountSun: transfer.amountBaseUnits,
      })
      if (verification.verified !== true) {
        return { success: false, reason: verification.reason || 'solidified-token-transfer-identity-mismatch' }
      }
    }

    const reportedFeeSun = safeIntegerString(info.fee ?? info.receipt?.fee)
    if (reportedFeeSun === null) return { success: false, reason: 'solidified-receipt-fee-missing' }
    const receipt = info.receipt && typeof info.receipt === 'object' ? info.receipt : {}
    const energyFeeSun = safeIntegerString(receipt.energy_fee, { allowNull: true })
    const netFeeSun = safeIntegerString(receipt.net_fee, { allowNull: true })
    const energyUsageTotal = safeIntegerString(receipt.energy_usage_total, { allowNull: true })
    const energyUsage = safeIntegerString(receipt.energy_usage, { allowNull: true })
    const originEnergyUsage = safeIntegerString(receipt.origin_energy_usage, { allowNull: true })
    const netUsage = safeIntegerString(receipt.net_usage, { allowNull: true })
    const energyPenaltyTotal = safeIntegerString(receipt.energy_penalty_total, { allowNull: true })
    const optionalRaw = [receipt.energy_fee, receipt.net_fee, receipt.energy_usage_total, receipt.energy_usage, receipt.origin_energy_usage, receipt.net_usage, receipt.energy_penalty_total]
    const optionalParsed = [energyFeeSun, netFeeSun, energyUsageTotal, energyUsage, originEnergyUsage, netUsage, energyPenaltyTotal]
    if (optionalRaw.some((value, index) => value !== undefined && value !== null && optionalParsed[index] === null)) {
      return { success: false, reason: 'invalid-solidified-fee-fields' }
    }
    if (transfer.asset === 'USDT') {
      // ResourceReceipt defines energy_usage as caller-paid and
      // origin_energy_usage as contract-creator-paid. Only caller Energy can
      // be attributed to this asset-principal account's delegated resource.
      const callerEnergy = BigInt(energyUsage ?? '0')
      const originEnergy = BigInt(originEnergyUsage ?? '0')
      if (energyUsageTotal === null || BigInt(energyUsageTotal) !== callerEnergy + originEnergy) {
        return { success: false, reason: 'caller-and-origin-energy-breakdown-unverifiable' }
      }
    }
    return {
      success: true,
      status: 'solidified-chain-costs-observed',
      network,
      transactionHash: hash,
      blockNumber,
      blockTimestampMs,
      executionResult: 'SUCCESS',
      reportedFeeSun,
      energyFeeSun,
      netFeeSun,
      energyUsageTotal,
      energyUsage,
      originEnergyUsage,
      netUsage,
      energyPenaltyTotal,
      evidenceSource: 'Tatum TRON SolidityNode transaction body and receipt',
    }
  } catch {
    return { success: false, reason: 'solidified-chain-cost-read-failed' }
  }
}

export function createSponsorChainCostObservationRouter(options = {}) {
  const env = options.env ?? process.env
  const lookupTransfer = options.lookupTransfer ?? getSponsorTransferForSubmission
  const readChainCosts = options.readChainCosts ?? ((transfer) =>
    readSolidifiedSponsorChainCosts({ transfer, env, fetchImpl: options.fetchImpl, tronWebFactory: options.tronWebFactory }))
  const persistObservation = options.persistObservation ?? recordSponsorChainCostObservation
  const listObservations = options.listObservations ?? listSponsorChainCostObservations
  const router = Router()

  router.post('/sponsorship/transfers/:idempotencyKey/observe-chain-costs', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Vary', 'Authorization')
    if (typeof env.SPONSOR_ADMIN_API_TOKEN !== 'string' || env.SPONSOR_ADMIN_API_TOKEN.length < 32) {
      return res.status(503).json({ success: false, error: 'sponsor-admin-not-configured', canSubmitSponsoredTransfer: false, feeSponsorBudgetSettled: false, sponsorFeeBudgetSettled: false })
    }
    if (!adminAuthorized(req, env)) {
      return res.status(401).json({ success: false, error: 'unauthorized', canSubmitSponsoredTransfer: false, feeSponsorBudgetSettled: false, sponsorFeeBudgetSettled: false })
    }
    const idempotencyKey = req.params?.idempotencyKey
    if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{24,160}$/.test(idempotencyKey)) {
      return res.status(400).json({ success: false, error: 'invalid-idempotency-key', canSubmitSponsoredTransfer: false })
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).length > 0) {
      return res.status(400).json({
        success: false, error: 'unexpected-fields', canSubmitSponsoredTransfer: false,
        message: 'This route uses the stored transaction identity and accepts no caller-supplied transaction hash, costs, address, or status.',
      })
    }
    try {
      const found = await lookupTransfer(idempotencyKey)
      if (found?.success !== true || !found.transfer) {
        const reason = found?.reason || 'sponsor-transfer-unavailable'
        return res.status(reason === 'transfer-not-found' ? 404 : 503).json({ success: false, error: reason, canSubmitSponsoredTransfer: false })
      }
      const transfer = found.transfer
      if (!['nile', 'shasta'].includes(transfer.network) || transfer.purpose !== 'asset-grant') {
        return res.status(409).json({ success: false, error: 'confirmed-testnet-asset-transfer-required', canSubmitSponsoredTransfer: false })
      }
      if (transfer.status !== 'confirmed' || typeof transfer.transactionHash !== 'string' || !TX_PATTERN.test(transfer.transactionHash)) {
        return res.status(409).json({
          success: false, error: 'confirmed-transfer-required', status: transfer.status,
          canSubmitSponsoredTransfer: false, feeSponsorBudgetSettled: false,
          message: 'Run exact solidified transfer verification and principal-ledger confirmation first.',
        })
      }
      const feeSponsorAddress = typeof env['SPONSOR_FEE_' + transfer.network.toUpperCase() + '_ADDRESS'] === 'string'
        ? env['SPONSOR_FEE_' + transfer.network.toUpperCase() + '_ADDRESS'].trim() : ''
      if (!isValidTronAddress(feeSponsorAddress) || feeSponsorAddress === transfer.sponsorAddress) {
        return res.status(409).json({
          success: false, error: 'distinct-fee-sponsor-address-required',
          requiredEnvironment: ['SPONSOR_FEE_' + transfer.network.toUpperCase() + '_ADDRESS'],
          canSubmitSponsoredTransfer: false, feeSponsorBudgetSettled: false,
        })
      }
      const costs = await readChainCosts(transfer)
      if (costs?.success !== true || costs.executionResult !== 'SUCCESS'
        || !Number.isSafeInteger(costs.blockNumber) || costs.blockNumber <= 0
        || !Number.isSafeInteger(costs.blockTimestampMs) || costs.blockTimestampMs <= 0
        || costs.transactionHash?.toLowerCase() !== transfer.transactionHash.toLowerCase()
        || costs.network !== transfer.network) {
        const reason = costs?.reason || 'solidified-chain-cost-read-failed'
        return res.status(reason === 'solidified-native-transfer-identity-mismatch'
          || reason === 'solidified-token-transfer-identity-mismatch'
          || reason === 'solidified-transaction-execution-failed' ? 409 : 503).json({
          success: false, error: reason, canSubmitSponsoredTransfer: false,
          feeSponsorBudgetSettled: false,
          message: 'No cost observation was written because the selected network did not return matching finalized transaction evidence.',
        })
      }
      const observation = await persistObservation({
        network: transfer.network,
        transactionHash: costs.transactionHash,
        idempotencyKey,
        sponsorReference: transfer.sponsorReference,
        feeSponsorAddress,
        assetPrincipalAddress: transfer.sponsorAddress,
        receiverAddress: transfer.receiverAddress,
        asset: transfer.asset,
        tokenContract: transfer.tokenContract ?? null,
        amountBaseUnits: transfer.amountBaseUnits,
        blockNumber: costs.blockNumber,
        blockTimestampMs: costs.blockTimestampMs,
        executionResult: costs.executionResult,
        reportedFeeSun: costs.reportedFeeSun,
        energyFeeSun: costs.energyFeeSun,
        netFeeSun: costs.netFeeSun,
        energyUsageTotal: costs.energyUsageTotal,
        energyUsage: costs.energyUsage,
        originEnergyUsage: costs.originEnergyUsage,
        netUsage: costs.netUsage,
        energyPenaltyTotal: costs.energyPenaltyTotal,
      })
      if (observation?.success !== true) {
        const reason = observation?.reason || 'chain-cost-observation-persistence-failed'
        const conflict = reason === 'chain-cost-observation-conflict'
        return res.status(conflict ? 409 : 503).json({
          success: false, error: reason, canSubmitSponsoredTransfer: false,
          feeSponsorBudgetSettled: false,
          message: 'Verified chain costs could not be recorded against the stored confirmed transfer.',
        })
      }
      return res.status(200).json({
        success: true,
        status: 'solidified-chain-costs-observed-not-settled',
        duplicate: observation.duplicate === true,
        network: transfer.network,
        transactionHash: costs.transactionHash,
        blockNumber: costs.blockNumber,
        executionResult: 'SUCCESS',
        observedCosts: {
          reportedFeeSun: costs.reportedFeeSun,
          energyFeeSun: costs.energyFeeSun,
          netFeeSun: costs.netFeeSun,
          energyUsageTotal: costs.energyUsageTotal,
          energyUsage: costs.energyUsage,
          originEnergyUsage: costs.originEnergyUsage,
          netUsage: costs.netUsage,
          energyPenaltyTotal: costs.energyPenaltyTotal,
        },
        persistence: 'postgresql-project-sponsor-chain-cost-observations',
        sponsorFeeBudgetSettled: false,
        feeSponsorDebitVerified: false,
        resourceCostAllocationVerified: false,
        canSubmitSponsoredTransfer: false,
        userFundedFallbackAllowed: false,
        note: 'The observation is read from matching solidified network data and bound to the persisted confirmed transfer. It does not prove the separate fee sponsor was debited or settle a resource-cost budget; those require provider-specific historical resource-consumption evidence.',
      })
    } catch {
      return res.status(503).json({
        success: false, error: 'chain-cost-observation-unavailable',
        canSubmitSponsoredTransfer: false, sponsorFeeBudgetSettled: false,
        userFundedFallbackAllowed: false,
      })
    }
  })

  router.get('/sponsorship/chain-cost-observations', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Vary', 'Authorization')
    if (typeof env.SPONSOR_ADMIN_API_TOKEN !== 'string' || env.SPONSOR_ADMIN_API_TOKEN.length < 32) {
      return res.status(503).json({ success: false, error: 'sponsor-admin-not-configured' })
    }
    if (!adminAuthorized(req, env)) return res.status(401).json({ success: false, error: 'unauthorized' })
    const network = req.query?.network === undefined ? null : req.query.network
    const limit = req.query?.limit === undefined ? 50 : Number(req.query.limit)
    if (network !== null && !['nile', 'shasta'].includes(network)) {
      return res.status(400).json({ success: false, error: 'invalid-network', observations: [] })
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return res.status(400).json({ success: false, error: 'invalid-limit', observations: [] })
    }
    const result = await listObservations({ network, limit })
    if (result?.success !== true) {
      return res.status(503).json({ success: false, error: result?.reason || 'observation-list-unavailable', observations: [] })
    }
    return res.json({
      success: true,
      status: 'sponsor-chain-cost-observations-read',
      count: result.observations.length,
      observations: result.observations,
      sponsorFeeBudgetSettled: false,
      canSubmitSponsoredTransfer: false,
    })
  })

  return router
}

export default createSponsorChainCostObservationRouter()
