import { timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import { getSponsorTransferForSubmission, transitionSponsorTransfer } from '../database.mjs'

const NETWORKS = new Set(['nile', 'shasta'])
const TX_PATTERN = /^[0-9a-f]{64}$/i
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{24,160}$/
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/

function validAdminToken(req, env) {
  const expectedValue = env.SPONSOR_ADMIN_API_TOKEN
  const header = req.headers?.authorization
  if (typeof expectedValue !== 'string' || expectedValue.length < 32
    || typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const supplied = Buffer.from(header.slice(7))
  const expected = Buffer.from(expectedValue)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

function verificationInstruction(transfer) {
  const hash = transfer.transactionHash
  const network = encodeURIComponent(transfer.network)
  const from = encodeURIComponent(transfer.sponsorAddress)
  const to = encodeURIComponent(transfer.receiverAddress)
  if (transfer.asset === 'TRX') {
    const query = new URLSearchParams({ network: transfer.network, from: transfer.sponsorAddress, to: transfer.receiverAddress, amountSun: transfer.amountBaseUnits })
    return {
      method: 'GET',
      path: `/api/tron/verify-native-transfer/${encodeURIComponent(hash)}?${query.toString()}`,
      expectedEvidence: 'Exact sender, receiver, amount, successful native TransferContract, and solidified receipt.',
    }
  }
  const query = new URLSearchParams({
    network: transfer.network,
    contract: transfer.tokenContract,
    from: transfer.sponsorAddress,
    to: transfer.receiverAddress,
    amountBaseUnits: transfer.amountBaseUnits,
  })
  return {
    method: 'GET',
    path: `/api/tron/verify-trc20-transfer/${encodeURIComponent(hash)}?${query.toString()}`,
    expectedEvidence: 'Exact TRC-20 contract, sender, receiver, amount, successful execution, unique Transfer event, and solidified receipt.',
  }
}

/**
 * Confirms sponsor-ledger principal spending only after a chain-verification
 * route has persisted independent solidified evidence. It never accepts caller-
 * asserted success or handles network-fee sponsor budgets.
 */
export function createSponsorSettlementRouter({
  env = process.env,
  lookupTransfer = getSponsorTransferForSubmission,
  confirmTransfer = transitionSponsorTransfer,
} = {}) {
  const router = Router()

  router.post('/sponsorship/transfers/:idempotencyKey/confirm', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Vary', 'Authorization')

    if (typeof env.SPONSOR_ADMIN_API_TOKEN !== 'string' || env.SPONSOR_ADMIN_API_TOKEN.length < 32) {
      return res.status(503).json({
        success: false,
        error: 'sponsor-admin-not-configured',
        message: 'Configure a server-only sponsor administrator token before reconciling sponsor ledger state.',
        submissionEnabled: false,
      })
    }
    if (!validAdminToken(req, env)) {
      return res.status(401).json({ success: false, error: 'unauthorized', submissionEnabled: false })
    }

    const idempotencyKey = req.params?.idempotencyKey
    if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
      return res.status(400).json({ success: false, error: 'invalid-idempotency-key', submissionEnabled: false })
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).some((key) => key !== 'transactionHash')) {
      return res.status(400).json({
        success: false,
        error: 'unexpected-fields',
        message: 'Only the optional stored transactionHash may be supplied; status, amount, receiver and verification cannot be caller-asserted.',
        submissionEnabled: false,
      })
    }
    if (body.transactionHash !== undefined
      && (typeof body.transactionHash !== 'string' || !TX_PATTERN.test(body.transactionHash))) {
      return res.status(400).json({ success: false, error: 'invalid-transaction-hash', submissionEnabled: false })
    }

    try {
      const lookup = await lookupTransfer(idempotencyKey)
      if (lookup?.success !== true || !lookup.transfer) {
        const reason = lookup?.reason || 'sponsor-transfer-unavailable'
        return res.status(reason === 'transfer-not-found' ? 404 : 503).json({
          success: false,
          error: reason,
          submissionEnabled: false,
        })
      }
      const transfer = lookup.transfer
      if (!NETWORKS.has(transfer.network)) {
        return res.status(409).json({
          success: false,
          error: 'testnet-only-ledger-confirmation',
          message: 'This settlement endpoint is limited to Nile and Shasta. Mainnet confirmation is not exposed here.',
          submissionEnabled: false,
        })
      }
      if (transfer.purpose !== 'asset-grant') {
        return res.status(409).json({
          success: false,
          error: 'asset-principal-transfer-required',
          message: 'Network-fee budgets and resource delegations are not receiver principal transfers and cannot be confirmed here.',
          submissionEnabled: false,
        })
      }
      if (!['TRX', 'USDT'].includes(transfer.asset)
        || (transfer.asset === 'TRX' && transfer.tokenContract != null)
        || (transfer.asset !== 'TRX' && (typeof transfer.tokenContract !== 'string' || !ADDRESS_PATTERN.test(transfer.tokenContract)))
        || typeof transfer.sponsorAddress !== 'string' || !ADDRESS_PATTERN.test(transfer.sponsorAddress)
        || typeof transfer.receiverAddress !== 'string' || !ADDRESS_PATTERN.test(transfer.receiverAddress)
        || typeof transfer.amountBaseUnits !== 'string' || !/^[1-9][0-9]{0,77}$/.test(transfer.amountBaseUnits)) {
        return res.status(503).json({
          success: false,
          error: 'stored-sponsor-transfer-invalid',
          message: 'The server-side transfer record is incomplete or malformed. No ledger state was changed.',
          submissionEnabled: false,
        })
      }
      if (typeof transfer.transactionHash !== 'string' || !TX_PATTERN.test(transfer.transactionHash)) {
        return res.status(409).json({
          success: false,
          error: 'stored-transaction-hash-required',
          message: 'Only a server-recorded transaction ID can be reconciled. No caller-supplied hash can replace it.',
          submissionEnabled: false,
        })
      }
      if (body.transactionHash !== undefined
        && body.transactionHash.toLowerCase() !== transfer.transactionHash.toLowerCase()) {
        return res.status(409).json({
          success: false,
          error: 'transaction-hash-conflict',
          message: 'The supplied transaction ID does not match the server-recorded sponsor transfer. No ledger state was changed.',
          submissionEnabled: false,
        })
      }
      if (!['submitted', 'confirmed'].includes(transfer.status)) {
        return res.status(409).json({
          success: false,
          error: 'submitted-transfer-required',
          status: transfer.status,
          message: 'Only a node-accepted, submitted transfer may be reconciled. Resolve ambiguous broadcasts by retrying/reconciling the original transaction first.',
          submissionEnabled: false,
        })
      }

      const result = await confirmTransfer({
        idempotencyKey,
        nextStatus: 'confirmed',
        transactionHash: transfer.transactionHash.toLowerCase(),
      })
      if (result?.updated !== true) {
        const reason = result?.reason || 'sponsor-transfer-confirmation-unavailable'
        const missingEvidence = reason === 'finalized-transfer-evidence-not-found'
        const code = missingEvidence ? 409
          : ['invalid-state-transition', 'transaction-hash-conflict', 'reservation-invariant-violated',
            'budget-invariant-violated', 'purpose-specific-fee-evidence-and-reconciliation-required',
            'unsupported-sponsor-transfer-purpose'].includes(reason) ? 409 : 503
        return res.status(code).json({
          success: false,
          error: reason,
          ...(missingEvidence ? { verificationRequired: verificationInstruction(transfer) } : {}),
          submissionEnabled: false,
          message: missingEvidence
            ? 'No matching persisted solidified transfer evidence exists yet. Run the indicated independent verifier against the selected testnet, ensure evidence was persisted, then retry this confirmation. The sponsor reservation remains unchanged.'
            : 'Sponsor ledger confirmation did not complete. The stored transfer and budget were not confirmed by this request.',
        })
      }

      const receiverBalanceQuery = transfer.asset === 'TRX'
        ? `/api/tron/native-balance?network=${encodeURIComponent(transfer.network)}&address=${encodeURIComponent(transfer.receiverAddress)}`
        : `/api/tron/token-balance?network=${encodeURIComponent(transfer.network)}&contract=${encodeURIComponent(transfer.tokenContract)}&address=${encodeURIComponent(transfer.receiverAddress)}`
      return res.status(200).json({
        success: true,
        status: 'ledger-confirmed-from-solidified-evidence',
        duplicate: result.duplicate === true,
        network: transfer.network,
        asset: transfer.asset,
        amountBaseUnits: transfer.amountBaseUnits,
        transactionHash: transfer.transactionHash.toLowerCase(),
        ledger: {
          status: 'confirmed',
          principalSpendRecorded: result.duplicate !== true,
          reservationReleased: result.duplicate !== true,
          evidenceSource: 'persisted exact-match solidified-chain verifier record',
        },
        receiverBalance: {
          status: 'read-separately',
          method: 'GET',
          path: receiverBalanceQuery,
          note: 'A current on-chain balance is separate from this transaction receipt and may change after the transfer.',
        },
        submissionEnabled: false,
        unpaidFallbackToUserFunds: false,
        note: 'This confirms the sponsor principal ledger only after the database independently matches the persisted verification record to the exact transaction, network, asset contract, sender, receiver and amount. It does not confirm exchange deposit credit or certify the fee sponsor settlement.',
      })
    } catch {
      return res.status(503).json({
        success: false,
        error: 'sponsor-transfer-confirmation-unavailable',
        submissionEnabled: false,
        message: 'Confirmation failed safely; reconcile the saved transaction and ledger before retrying.',
      })
    }
  })

  return router
}

export default createSponsorSettlementRouter()
