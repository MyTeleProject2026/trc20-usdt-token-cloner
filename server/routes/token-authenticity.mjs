import { Router } from 'express'
import { isValidTronAddress } from '../tron-address.mjs'

const MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const TRONSCAN_ORIGIN = 'https://apilist.tronscanapi.com'
const NETWORKS = new Set(['mainnet', 'nile', 'shasta'])
const VERIFY_LABELS = Object.freeze({
  0: 'unverified-source',
  1: 'partially-verified-source',
  2: 'fully-verified-source',
})
const TOKEN_LEVEL_LABELS = Object.freeze({
  0: 'unknown',
  1: 'neutral',
  2: 'ok',
  3: 'suspicious',
  4: 'unsafe',
})

function textField(value, maxLength = 120) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, maxLength) : ''
}

function scanRecord(record) {
  if (!record || typeof record !== 'object' || typeof record.address !== 'string') return null
  const verifyStatus = Number(record.verify_status)
  const tokenInfo = record.tokenInfo && typeof record.tokenInfo === 'object' ? record.tokenInfo : {}
  const rawLevel = Number(tokenInfo.tokenLevel)
  const riskLevel = Number.isInteger(rawLevel) && rawLevel >= 0 && rawLevel <= 4 ? rawLevel : null
  return {
    contractAddress: textField(record.address, 64),
    sourceVerificationStatus: Object.hasOwn(VERIFY_LABELS, verifyStatus) ? VERIFY_LABELS[verifyStatus] : 'unknown',
    sourceVerificationCode: Object.hasOwn(VERIFY_LABELS, verifyStatus) ? verifyStatus : null,
    tokenName: textField(tokenInfo.tokenName, 80),
    tokenSymbol: textField(tokenInfo.tokenAbbr, 32),
    tokenType: textField(tokenInfo.tokenType, 24),
    tokenDecimals: Number.isInteger(Number(tokenInfo.tokenDecimal)) && Number(tokenInfo.tokenDecimal) >= 0 && Number(tokenInfo.tokenDecimal) <= 36
      ? Number(tokenInfo.tokenDecimal)
      : null,
    explorerRiskLevel: riskLevel === null ? 'unknown' : TOKEN_LEVEL_LABELS[riskLevel],
    explorerRiskCode: riskLevel,
    riskFeedback: record.feedbackRisk === true,
    riskTag: textField(record.redTag, 80),
    publicLabel: textField(record.publicTag, 80),
    officialLabel: textField(record.blueTag, 80),
    officialLabelUrl: textField(record.blueTagUrl, 160),
    creatorAddress: textField(record.creator?.address, 64),
    explorer: 'TronScan',
    explorerContractUrl: 'https://tronscan.org/#/contract/' + encodeURIComponent(record.address),
  }
}

/**
 * Read-only token evidence endpoint. Explorer source verification and risk
 * labels are evidence, not a guarantee the token is safe, redeemable, or issued
 * by the name displayed by the token itself.
 */
export function createTokenAuthenticityRouter({
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
} = {}) {
  const router = Router()
  router.get('/token-authenticity', async (req, res) => {
    res.setHeader?.('Cache-Control', 'no-store')
    res.setHeader?.('Pragma', 'no-cache')

    const { network, contract } = req.query || {}
    if (typeof network !== 'string' || !NETWORKS.has(network)) {
      return res.status(400).json({ success: false, error: 'invalid-network', message: 'network must be mainnet, nile, or shasta.' })
    }
    if (typeof contract !== 'string' || !isValidTronAddress(contract)) {
      return res.status(400).json({ success: false, error: 'invalid-contract-address', message: 'contract must be a valid TRON Base58 address.' })
    }

    const officialMainnetUsdtAddressMatch = network === 'mainnet' && contract === MAINNET_USDT
    const common = {
      success: true,
      network,
      contractAddress: contract,
      officialMainnetUsdtAddressMatch,
      officialIdentityReference: officialMainnetUsdtAddressMatch ? 'https://tron.network/usdt/' : null,
      evidenceScope: 'contract metadata and explorer annotations; not an audit or a guarantee of asset legitimacy',
    }

    // TronScan's public contract-verification status is for Mainnet. Do not
    // query Mainnet for a testnet contract or transfer labels across networks.
    if (network !== 'mainnet') {
      return res.status(200).json({
        ...common,
        explorerStatus: 'not-available-for-testnet',
        sourceVerificationStatus: 'unknown',
        explorerRiskLevel: 'unknown',
      })
    }

    const url = new URL('/api/contract', TRONSCAN_ORIGIN)
    url.searchParams.set('contract', contract)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const headers = { Accept: 'application/json' }
      if (typeof env.TRONSCAN_PRO_API_KEY === 'string' && env.TRONSCAN_PRO_API_KEY.trim()) {
        headers['TRON-PRO-API-KEY'] = env.TRONSCAN_PRO_API_KEY.trim()
      }
      const response = await fetchImpl(url.toString(), {
        method: 'GET',
        headers,
        signal: controller.signal,
        redirect: 'error',
      })
      if (!response?.ok) {
        return res.status(200).json({
          ...common,
          explorerStatus: 'unavailable',
          sourceVerificationStatus: 'unknown',
          explorerRiskLevel: 'unknown',
        })
      }
      const body = await response.json()
      const records = Array.isArray(body?.data) ? body.data : []
      const record = records.find((item) => item?.address === contract)
      if (!record) {
        return res.status(200).json({
          ...common,
          explorerStatus: 'contract-not-indexed',
          sourceVerificationStatus: 'unknown',
          explorerRiskLevel: 'unknown',
        })
      }
      const metadata = scanRecord(record)
      if (!metadata) {
        return res.status(200).json({
          ...common,
          explorerStatus: 'invalid-explorer-response',
          sourceVerificationStatus: 'unknown',
          explorerRiskLevel: 'unknown',
        })
      }
      return res.status(200).json({
        ...common,
        explorerStatus: 'available',
        ...metadata,
        officialMainnetUsdtAddressMatch,
      })
    } catch {
      return res.status(200).json({
        ...common,
        explorerStatus: 'unavailable',
        sourceVerificationStatus: 'unknown',
        explorerRiskLevel: 'unknown',
      })
    } finally {
      clearTimeout(timeout)
    }
  })
  return router
}

export { MAINNET_USDT as OFFICIAL_MAINNET_USDT_CONTRACT }
