import { createHash } from 'node:crypto'
import { Router } from 'express'
import { TronWeb } from 'tronweb'
import { getWalletAuthSession } from '../database.mjs'
import { createPublicTronReadClient } from '../public-tron-read-client.mjs'
import { verifyRestrictedTrxEscrowEvidence } from '../restricted-trx-escrow-verifier.mjs'

const REQUEST_ID_RE = /^0x[0-9a-f]{64}$/i
const TXID_RE = /^[0-9a-f]{64}$/i

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function bearerToken(req) {
  const value = req.get('authorization') || ''
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(value)
  return match ? match[1] : ''
}

function decodeWord(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error('invalid-contract-read-result')
  }
  return BigInt('0x' + value)
}

function decodeAddressWord(tronWeb, value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value) || !/^0{24}/i.test(value)) {
    throw new Error('invalid-contract-address-result')
  }
  return tronWeb.address.fromHex('41' + value.slice(24))
}

/**
 * Owner-authenticated escrow reconciliation.
 *
 * Reads only TRON solidified state. It does not create, sign, broadcast, fund,
 * or release a transaction. All returned balance figures are derived from the
 * configured escrow contract and chain state.
 */
export function createRestrictedTrxEscrowVerificationRouter({
  env = process.env,
  getSession = getWalletAuthSession,
  publicClient = null,
  now = () => Date.now(),
} = {}) {
  const router = Router()
  const client = publicClient || createPublicTronReadClient({
    origin: env.TRONGRID_API_ORIGIN || 'https://api.trongrid.io',
    apiKey: env.TRONGRID_API_KEY || '',
  })

  router.get('/verify/:requestId/:txid', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Vary', 'Authorization, Origin')

    const token = bearerToken(req)
    const origin = req.get('origin') || ''
    const ownerAddress = String(env.TREASURY_OWNER_ADDRESS || env.OWNER_WALLET_ADDRESS || '').trim()
    if (!token || !origin || !ownerAddress || !TronWeb.isAddress(ownerAddress)) {
      return res.status(401).json({ success: false, error: 'owner-session-required', verified: false })
    }

    let sessionResult
    try {
      sessionResult = await getSession({ tokenHash: digest(token), origin, nowMs: now() })
    } catch {
      sessionResult = null
    }
    const session = sessionResult?.session
    if (sessionResult?.success !== true || !session
      || session.network !== 'mainnet' || session.origin !== origin) {
      return res.status(401).json({ success: false, error: 'owner-session-invalid-or-expired', verified: false })
    }
    if (session.address !== ownerAddress) {
      return res.status(403).json({ success: false, error: 'owner-wallet-not-authorized', verified: false })
    }

    const requestId = req.params.requestId || ''
    const txid = req.params.txid || ''
    if (!REQUEST_ID_RE.test(requestId) || !TXID_RE.test(txid)) {
      return res.status(400).json({ success: false, error: 'invalid-request-id-or-transaction-id', verified: false })
    }

    const contractAddress = String(env.RESTRICTED_TRX_ESCROW_CONTRACT || '').trim()
    const beneficiary = String(env.RESTRICTED_TRX_BENEFICIARY_ADDRESS || '').trim()
    if (!TronWeb.isAddress(contractAddress) || !TronWeb.isAddress(beneficiary)) {
      return res.status(503).json({
        success: false,
        error: 'escrow-contract-or-beneficiary-not-configured',
        verified: false,
        note: 'Set the audited deployed contract address and exact beneficiary address before verification.',
      })
    }

    try {
      const expectedRuntimeCodeHash = String(env.RESTRICTED_TRX_ESCROW_RUNTIME_CODE_SHA256 || '').trim().toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(expectedRuntimeCodeHash)) {
        return res.status(503).json({
          success: false,
          verified: false,
          error: 'audited-escrow-runtime-code-hash-not-configured',
          creditableAmountSun: '0',
        })
      }
      const runtime = await client.getContractRuntimeCode(contractAddress)
      const actualRuntimeCodeHash = createHash('sha256').update(runtime.runtimeCode, 'hex').digest('hex')
      if (actualRuntimeCodeHash !== expectedRuntimeCodeHash) {
        return res.status(409).json({
          success: false,
          verified: false,
          error: 'escrow-runtime-code-hash-mismatch',
          creditableAmountSun: '0',
        })
      }
      const tronWeb = new TronWeb({ fullHost: 'https://api.trongrid.io' })
      const contractHex = tronWeb.address.toHex(contractAddress)
      const [transactionEvidence, account] = await Promise.all([
        client.getSolidifiedTransaction(txid),
        client.getSolidifiedAccount(contractAddress),
      ])
      if (!transactionEvidence.found || !transactionEvidence.solidifiedReceiptFound) {
        return res.status(202).json({
          success: false,
          verified: false,
          error: 'transaction-not-yet-solidified',
          creditableAmountSun: '0',
          explorerUrl: 'https://tronscan.org/#/transaction/' + txid,
        })
      }

      const [positionCall, liabilitiesCall, providerCall, beneficiaryCall] = await Promise.all([
        client.triggerSolidifiedConstantContract({
          contractAddress,
          functionSelector: 'getPosition(bytes32)',
          parameter: requestId.slice(2),
          ownerAddress,
        }),
        client.triggerSolidifiedConstantContract({
          contractAddress,
          functionSelector: 'totalLockedSun()',
          parameter: '',
          ownerAddress,
        }),
        client.triggerSolidifiedConstantContract({
          contractAddress,
          functionSelector: 'provider()',
          parameter: '',
          ownerAddress,
        }),
        client.triggerSolidifiedConstantContract({
          contractAddress,
          functionSelector: 'restrictedBeneficiary()',
          parameter: '',
          ownerAddress,
        }),
      ])

      const positionHex = positionCall.resultHex
      if (!/^[0-9a-f]{256}$/i.test(positionHex)) throw new Error('invalid-position-return-data')
      const providerHex = providerCall.resultHex
      if (!/^[0-9a-f]{64}$/i.test(providerHex)) throw new Error('invalid-provider-return-data')

      const position = {
        beneficiary: decodeAddressWord(tronWeb, positionHex.slice(0, 64)),
        amountSun: decodeWord(positionHex.slice(64, 128)).toString(),
        unlockAt: decodeWord(positionHex.slice(128, 192)).toString(),
        claimed: decodeWord(positionHex.slice(192, 256)) !== 0n,
      }
      const providerAddress = decodeAddressWord(tronWeb, providerHex)
      const restrictedBeneficiary = decodeAddressWord(tronWeb, beneficiaryCall.resultHex)
      if (restrictedBeneficiary !== beneficiary) {
        return res.status(409).json({
          success: false,
          verified: false,
          error: 'configured-beneficiary-does-not-match-immutable-contract-beneficiary',
          creditableAmountSun: '0',
        })
      }
      const totalLockedLiabilitiesSun = decodeWord(liabilitiesCall.resultHex).toString()

      const result = verifyRestrictedTrxEscrowEvidence({
        expectedRequestId: requestId,
        expectedBeneficiary: beneficiary,
        expectedContract: contractAddress,
        expectedContractHex: contractHex,
        expectedTxId: txid,
        expectedProvider: providerAddress,
        transaction: transactionEvidence.transaction,
        receipt: transactionEvidence.receipt,
        position,
        contractBalanceSun: account.balanceSun,
        totalLockedLiabilitiesSun,
      })

      return res.status(result.verified ? 200 : 409).json({
        success: result.verified,
        verified: result.verified,
        result,
        bitpieWalletBalanceChanged: false,
        note: 'This verifies a contract-held restricted position linked to the Bitpie address. It does not create a normal Bitpie wallet deposit or change the balance displayed by the Bitpie app.',
      })
    } catch {
      return res.status(503).json({
        success: false,
        verified: false,
        error: 'solidified-escrow-verification-unavailable',
        creditableAmountSun: '0',
        note: 'No escrow credit is recognized unless all solidified chain and contract-state checks succeed.',
      })
    }
  })

  return router
}

export default createRestrictedTrxEscrowVerificationRouter()
