import { createHash } from 'node:crypto'
import { Router } from 'express'
import { TronWeb } from 'tronweb'
import { getWalletAuthSession } from '../database.mjs'
import { isValidTronAddress } from '../tron-address.mjs'
import { tatumProviderFetch } from '../tatum-provider-fetch.mjs'

const MAINNET_GATEWAY = 'https://tron-mainnet.gateway.tatum.io'
const ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const UINT_RE = /^(0|[1-9][0-9]{0,77})$/
const UINT_POSITIVE_RE = /^[1-9][0-9]{0,77}$/
const TXID_RE = /^[0-9a-f]{64}$/i
const PAYOUT_SELECTOR = 'payoutBoth(address,uint256,uint256,bytes32)'
const DEFAULT_MAX_FEE_LIMIT_SUN = '300000000'
const FEE_BUFFER_BPS = 12500n

function clean(value, max = 512) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function configuredOrigins(env) {
  return [env.FRONTEND_ORIGIN, env.PACKAGED_APP_ORIGINS, env.OKX_UI_ORIGIN, env.TRON_TRANSFER_UI_ORIGIN]
    .flatMap((value) => typeof value === 'string' ? value.split(',') : [])
    .map((value) => value.trim()).filter(Boolean)
}

function requestOrigin(req) {
  const origin = clean(req.headers?.origin)
  try {
    const parsed = new URL(origin)
    return parsed.origin === origin && parsed.protocol === 'https:' ? origin : ''
  } catch {
    return ''
  }
}

async function requireOwner(req, env) {
  const origin = requestOrigin(req)
  if (!origin || !configuredOrigins(env).includes(origin)) return { ok: false, status: 403, error: 'owner-origin-not-allowed' }
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(clean(req.headers?.authorization, 4096))
  if (!match) return { ok: false, status: 401, error: 'owner-session-required' }
  const ownerAddress = clean(env.OWNER_WALLET_ADDRESS, 64)
  if (!ADDRESS_RE.test(ownerAddress) || !isValidTronAddress(ownerAddress)) return { ok: false, status: 503, error: 'owner-wallet-not-configured' }
  let lookup
  try {
    lookup = await getWalletAuthSession({
      tokenHash: createHash('sha256').update(match[1]).digest('hex'),
      origin,
      nowMs: Date.now(),
    })
  } catch {
    return { ok: false, status: 503, error: 'owner-session-storage-unavailable' }
  }
  if (lookup?.success !== true) return { ok: false, status: 503, error: 'owner-session-storage-unavailable' }
  const session = lookup.session
  if (!session || session.network !== 'mainnet' || session.address !== ownerAddress
    || session.origin !== origin || session.expiresAt <= Date.now()) {
    return { ok: false, status: 401, error: 'owner-session-invalid-or-expired' }
  }
  return { ok: true, address: ownerAddress }
}

function parseUInt(value, label, { positive = false } = {}) {
  const pattern = positive ? UINT_POSITIVE_RE : UINT_RE
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(label + '-invalid')
  return BigInt(value)
}

function addressHex(tronWeb, address) {
  if (!ADDRESS_RE.test(address) || !isValidTronAddress(address) || !tronWeb.isAddress(address)) return null
  const hex = String(tronWeb.address.toHex(address) || '').replace(/^0x/i, '').toLowerCase()
  return /^41[0-9a-f]{40}$/.test(hex) ? hex : null
}

function wordAddress(hex41) {
  return hex41.slice(2).padStart(64, '0')
}

function wordUint(value) {
  const hex = BigInt(value).toString(16)
  if (hex.length > 64) throw new Error('ABI uint256 overflow')
  return hex.padStart(64, '0')
}

function uintFromProvider(value, label) {
  if (value === undefined || value === null) return '0'
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  if (typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value)) return value
  throw new Error('invalid-' + label)
}

function protobufVarintLength(value) {
  let remaining = BigInt(value)
  let length = 1
  while (remaining >= 128n) { remaining >>= 7n; length += 1 }
  return length
}

export function estimateDirectSignedTransactionBytes(rawDataHex) {
  if (typeof rawDataHex !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(rawDataHex)) {
    throw new Error('Invalid TRON raw_data_hex for signed-byte estimation.')
  }
  const rawDataBytes = rawDataHex.length / 2
  // Outer Transaction.raw_data field plus one 65-byte ECDSA signature field.
  return rawDataBytes + 1 + protobufVarintLength(rawDataBytes) + 1 + protobufVarintLength(65) + 65
}

function trxDecimal(sun) {
  const amount = BigInt(sun)
  const whole = amount / 1_000_000n
  const fraction = (amount % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return fraction ? whole.toString() + '.' + fraction : whole.toString()
}

export function directPayoutTransactionMatches(transaction, { ownerHex, routerHex, parameter }) {
  if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) return false
  if (typeof transaction.txID !== 'string' || !TXID_RE.test(transaction.txID)
    || typeof transaction.raw_data_hex !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(transaction.raw_data_hex)) return false
  if (!transaction.raw_data || !Array.isArray(transaction.raw_data.contract)
    || transaction.raw_data.contract.length !== 1
    || transaction.raw_data.contract[0]?.type !== 'TriggerSmartContract') return false
  const value = transaction.raw_data.contract[0]?.parameter?.value
  return String(value?.owner_address || '').replace(/^0x/i, '').toLowerCase() === ownerHex.toLowerCase()
    && String(value?.contract_address || '').replace(/^0x/i, '').toLowerCase() === routerHex.toLowerCase()
    && Number(value?.call_value || 0) === 0
    && String(value?.data || '').replace(/^0x/i, '').toLowerCase() === (parameter.selector + parameter.arguments).toLowerCase()
    && (!Array.isArray(transaction.signature) || transaction.signature.length === 0)
}

export function createTronDirectFeePreflightRouter({
  env = process.env,
  fetchImpl = tatumProviderFetch,
  tronWebFactory = () => new TronWeb({ fullHost: MAINNET_GATEWAY }),
  timeoutMs = 12000,
} = {}) {
  const router = Router()

  router.post('/direct-fee-preflight', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Vary', 'Origin')

    const auth = await requireOwner(req, env)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    const allowed = new Set(['recipientAddress', 'nativeTrxAmountSun', 'traxAmountBaseUnits', 'payoutReference'])
    if (Object.keys(body).some((key) => !allowed.has(key))) {
      return res.status(400).json({ success: false, status: 'unexpected-fields', message: 'Only recipientAddress, nativeTrxAmountSun, traxAmountBaseUnits and payoutReference are accepted.' })
    }

    const recipientAddress = clean(body.recipientAddress, 64)
    const payoutReference = clean(body.payoutReference, 66)
    let nativeTrxAmount
    let traxAmount
    try {
      nativeTrxAmount = parseUInt(body.nativeTrxAmountSun, 'native-trx-amount', { positive: true })
      traxAmount = parseUInt(body.traxAmountBaseUnits, 'trax-amount', { positive: true })
    } catch (error) {
      return res.status(400).json({ success: false, status: 'invalid-amount', message: 'Both payout amounts must be positive integer base-unit strings.' })
    }
    if (!ADDRESS_RE.test(recipientAddress) || !isValidTronAddress(recipientAddress)) {
      return res.status(400).json({ success: false, status: 'invalid-recipient', message: 'Enter a valid TRON Mainnet recipient address.' })
    }
    if (!/^0x[0-9a-f]{64}$/i.test(payoutReference)) {
      return res.status(400).json({ success: false, status: 'invalid-payout-reference', message: 'payoutReference must be a unique 32-byte 0x-prefixed hex value.' })
    }
    if (nativeTrxAmount > BigInt(Number.MAX_SAFE_INTEGER)) {
      return res.status(400).json({ success: false, status: 'native-trx-amount-too-large', message: 'Native TRX amount must fit the safe SUN amount range.' })
    }

      const routerAddress = clean(env.TRON_DIRECT_PAYOUT_ROUTER_ADDRESS, 64)
    if (!ADDRESS_RE.test(routerAddress) || !isValidTronAddress(routerAddress)) {
      return res.status(503).json({
        success: false,
        status: 'direct-payout-router-not-configured',
        requiredEnvironment: ['TRON_DIRECT_PAYOUT_ROUTER_ADDRESS'],
        message: 'Configure the deployed direct dual-asset payout router Mainnet address. The backend reads its token and treasury links from chain state.',
      })
    }

    const maxFeeLimit = (() => {
      const configured = clean(env.TRON_DIRECT_MAX_FEE_LIMIT_SUN, 40) || DEFAULT_MAX_FEE_LIMIT_SUN
      return /^(0|[1-9][0-9]{0,15})$/.test(configured) ? BigInt(configured) : 0n
    })()
    if (maxFeeLimit <= 0n || maxFeeLimit > BigInt(Number.MAX_SAFE_INTEGER)) return res.status(503).json({ success: false, status: 'invalid-fee-limit-configuration' })

    try {
      const tronWeb = tronWebFactory()
      const ownerHex = addressHex(tronWeb, auth.address)
      const recipientHex = addressHex(tronWeb, recipientAddress)
      const routerHex = addressHex(tronWeb, routerAddress)
      if (!ownerHex || !recipientHex || !routerHex) {
        return res.status(400).json({ success: false, status: 'invalid-address-checksum' })
      }

      const parameter = wordAddress(recipientHex) + wordUint(nativeTrxAmount) + wordUint(traxAmount) + payoutReference.slice(2).toLowerCase()
      const encoded = { selector: tronWeb.sha3(PAYOUT_SELECTOR).slice(2, 10), arguments: parameter }
      const headers = { Accept: 'application/json', 'Content-Type': 'application/json', 'x-api-key': clean(env.TATUM_MAINNET_API_KEY || env.TATUM_API_KEY, 2048) }
      if (!headers['x-api-key']) return res.status(503).json({ success: false, status: 'tatum-mainnet-api-key-not-configured' })

      const post = async (path, payload) => {
        const response = await fetchImpl(MAINNET_GATEWAY + '/' + path.replace(/^\/+/, ''), {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        })
        const result = await response.json().catch(() => null)
        if (!response.ok || !result || typeof result !== 'object' || Array.isArray(result) || result.Error || result.error) {
          const failure = new Error('mainnet-provider-request-failed')
          failure.status = response.status || 502
          throw failure
        }
        return result
      }

      const rpcBase = { owner_address: ownerHex, contract_address: routerHex, function_selector: PAYOUT_SELECTOR, parameter, call_value: 0, visible: false }
      const readRouterAddress = async (functionSelector) => {
        const result = await post('walletsolidity/triggerconstantcontract', {
          owner_address: ownerHex,
          contract_address: routerHex,
          function_selector: functionSelector,
          parameter: '',
          visible: false,
        })
        const encoded = Array.isArray(result?.constant_result) ? String(result.constant_result[0] || '') : ''
        const hex = encoded.replace(/^0x/i, '').toLowerCase()
        if (result?.result?.result !== true || !/^[0-9a-f]{64}$/.test(hex)) throw new Error('router-link-read-failed')
        const base58 = tronWeb.address.fromHex('41' + hex.slice(-40))
        if (!isValidTronAddress(base58)) throw new Error('router-link-address-invalid')
        return base58
      }
      const [simulation, resourcesPayload, accountPayload, chainParameters, tokenAddress, nativeTreasuryAddress] = await Promise.all([
        post('walletsolidity/triggerconstantcontract', rpcBase),
        post('walletsolidity/getaccountresource', { address: ownerHex, visible: false }),
        post('walletsolidity/getaccount', { address: ownerHex, visible: false }),
        post('walletsolidity/getchainparameters', {}),
        readRouterAddress('traxToken()'),
        readRouterAddress('nativeTreasury()'),
      ])

      if (simulation?.result?.result !== true) {
        const code = typeof simulation?.result?.code === 'string' ? simulation.result.code : 'CONTRACT_SIMULATION_FAILED'
        return res.status(422).json({
          success: false,
          status: 'payout-simulation-rejected',
          simulationCode: code,
          energyRequired: simulation?.energy_used == null ? null : String(simulation.energy_used),
          message: 'The TRON node could not simulate this exact dual-asset payout. Check recipient lock state, router permissions, native treasury balance and TRӾ backing. No transaction was prepared or broadcast.',
          transactionPrepared: false,
          transactionBroadcast: false,
        })
      }

      const energyRequired = parseUInt(String(simulation.energy_used ?? ''), 'energy-required', { positive: true })
      const resourceNumber = (key) => uintFromProvider(resourcesPayload?.[key], key)
      const energyLimit = BigInt(resourceNumber('EnergyLimit'))
      const energyUsed = BigInt(resourceNumber('EnergyUsed'))
      const netLimit = BigInt(resourceNumber('NetLimit'))
      const netUsed = BigInt(resourceNumber('NetUsed'))
      const freeNetLimit = BigInt(resourceNumber('freeNetLimit'))
      const freeNetUsed = BigInt(resourceNumber('freeNetUsed'))
      if (energyUsed > energyLimit || netUsed > netLimit || freeNetUsed > freeNetLimit) throw new Error('invalid-resource-accounting')
      const availableEnergy = energyLimit - energyUsed
      const availableBandwidth = (netLimit - netUsed) + (freeNetLimit - freeNetUsed)
      const trxBalanceSun = BigInt(uintFromProvider(accountPayload?.balance, 'owner-trx-balance'))
      const chain = Array.isArray(chainParameters?.chainParameter) ? chainParameters.chainParameter : []
      const energyPrice = BigInt(uintFromProvider(chain.find((item) => item?.key === 'getEnergyFee')?.value, 'energy-price'))
      const bandwidthPrice = BigInt(uintFromProvider(chain.find((item) => item?.key === 'getTransactionFee')?.value, 'bandwidth-price'))
      if (energyPrice <= 0n || bandwidthPrice <= 0n) throw new Error('invalid-chain-fee-parameters')

      const energyShortfall = energyRequired > availableEnergy ? energyRequired - availableEnergy : 0n
      const estimatedEnergyFeeSun = energyShortfall * energyPrice
      const feeLimitSun = (energyRequired * energyPrice * FEE_BUFFER_BPS + 9999n) / 10000n
      if (feeLimitSun > maxFeeLimit) {
        return res.status(422).json({
          success: false,
          status: 'fee-limit-exceeds-owner-policy',
          feeLimitSun: feeLimitSun.toString(),
          configuredMaximumFeeLimitSun: maxFeeLimit.toString(),
          energyRequired: energyRequired.toString(),
          availableEnergy: availableEnergy.toString(),
          transactionPrepared: false,
          transactionBroadcast: false,
        })
      }

      const draft = await post('wallet/triggersmartcontract', {
        ...rpcBase,
        fee_limit: Number(feeLimitSun),
      })
      if (!directPayoutTransactionMatches(draft?.transaction, { ownerHex, routerHex, parameter: encoded })) {
        return res.status(502).json({
          success: false,
          status: 'unsigned-transaction-validation-failed',
          transactionPrepared: false,
          transactionBroadcast: false,
          message: 'TRON Mainnet did not return an unsigned transaction matching the exact owner, router, recipient and payout amounts.',
        })
      }

      const signedBytes = estimateDirectSignedTransactionBytes(draft.transaction.raw_data_hex)
      const bandwidthShortfall = BigInt(signedBytes) > availableBandwidth ? BigInt(signedBytes) - availableBandwidth : 0n
      const estimatedBandwidthFeeSun = bandwidthShortfall * bandwidthPrice
      const estimatedTotalFeeSun = estimatedEnergyFeeSun + estimatedBandwidthFeeSun
      const canOwnerPay = trxBalanceSun >= estimatedTotalFeeSun
      const blockers = []
      if (energyShortfall > 0n && trxBalanceSun < estimatedEnergyFeeSun) blockers.push('owner-trx-balance-insufficient-for-energy-shortfall')
      if (bandwidthShortfall > 0n && trxBalanceSun < estimatedTotalFeeSun) blockers.push('owner-trx-balance-insufficient-for-bandwidth-shortfall')
      if (!canOwnerPay) blockers.push('owner-network-fee-balance-insufficient')
      blockers.push('owner-must-sign-the-prepared-transaction-in-tronlink')
      blockers.push('actual-bandwidth-and-energy-may-vary-at-broadcast-time')

      return res.json({
        success: true,
        status: canOwnerPay ? 'direct-owner-fee-preflight-passed' : 'direct-owner-fee-funding-required',
        network: 'TRON Mainnet',
        payer: 'configured-owner-wallet',
        ownerAddress: auth.address,
        recipientAddress,
        routerAddress,
        tokenAddress,
        nativeTreasuryAddress,
        nativeTrxAmountSun: nativeTrxAmount.toString(),
        nativeTrxAmount: trxDecimal(nativeTrxAmount),
        traxAmountBaseUnits: traxAmount.toString(),
        payoutReference,
        energy: {
          required: energyRequired.toString(),
          available: availableEnergy.toString(),
          shortfall: energyShortfall.toString(),
          currentPriceSunPerEnergy: energyPrice.toString(),
          estimatedFeeSun: estimatedEnergyFeeSun.toString(),
          feeLimitSun: feeLimitSun.toString(),
          feeLimitTrx: trxDecimal(feeLimitSun),
        },
        bandwidth: {
          signedTransactionBytes: signedBytes,
          available: availableBandwidth.toString(),
          shortfall: bandwidthShortfall.toString(),
          currentPriceSunPerByte: bandwidthPrice.toString(),
          estimatedFeeSun: estimatedBandwidthFeeSun.toString(),
          estimatedFeeTrx: trxDecimal(estimatedBandwidthFeeSun),
        },
        totalEstimatedNetworkFeeSun: estimatedTotalFeeSun.toString(),
        totalEstimatedNetworkFeeTrx: trxDecimal(estimatedTotalFeeSun),
        ownerTrxBalanceSun: trxBalanceSun.toString(),
        canOwnerPayEstimatedFee: canOwnerPay,
        blockers,
        unsignedTransaction: draft.transaction,
        transactionPrepared: true,
        transactionSigned: false,
        transactionBroadcast: false,
        submissionEnabled: false,
        note: 'Direct owner-paid preflight. The backend queries Mainnet resources, chain prices, and simulates the exact router call. The owner signs the returned unsigned transaction in TronLink. This is an estimate, not a fee guarantee; no sponsor wallet, signing key, transaction signature or broadcast is used.',
      })
    } catch (error) {
      return res.status(Number.isInteger(error?.status) ? error.status : 502).json({
        success: false,
        status: 'direct-owner-fee-preflight-unavailable',
        message: 'Could not complete the TRON Mainnet resource and fee preflight. No transaction was signed or broadcast.',
        errorCategory: error instanceof Error ? error.message : 'provider-error',
        transactionPrepared: false,
        transactionBroadcast: false,
      })
    }
  })

  return router
}
