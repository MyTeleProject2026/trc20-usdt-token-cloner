import { Router } from 'express'
import { recordTransferVerification } from '../database.mjs'

const NETWORKS = Object.freeze({
  mainnet: 'https://api.trongrid.io',
  shasta: 'https://api.shasta.trongrid.io',
  nile: 'https://nile.trongrid.io',
})
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const TX_PATTERN = /^[0-9a-fA-F]{64}$/
const BASE_UNITS_PATTERN = /^[1-9][0-9]{0,77}$/
const UINT256_MAX = (1n << 256n) - 1n
const TRANSFER_SELECTOR = 'a9059cbb'
const TRANSFER_EVENT_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const OFFICIAL_MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

function canonicalHexAddress(value) {
  if (typeof value !== 'string') return null
  let hex = value.trim().replace(/^0x/i, '').toLowerCase()
  if (hex.length === 42 && hex.startsWith('41')) hex = hex.slice(2)
  return /^[0-9a-f]{40}$/.test(hex) ? hex : null
}

function canonicalBase58Address(tronWeb, value) {
  if (typeof value !== 'string' || !ADDRESS_PATTERN.test(value)) return null
  try {
    if (!tronWeb.isAddress(value)) return null
    return canonicalHexAddress(tronWeb.address.toHex(value))
  } catch {
    return null
  }
}

function canonicalTopicAddress(value) {
  if (typeof value !== 'string') return null
  const topic = value.replace(/^0x/i, '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(topic) || !topic.startsWith('0'.repeat(24))) return null
  return topic.slice(24)
}

function readTransferLog(log, contractBytes) {
  if (!log || typeof log !== 'object' || !Array.isArray(log.topics) || log.topics.length < 3) return null
  if (canonicalHexAddress(log.address) !== contractBytes) return null
  if (typeof log.topics[0] !== 'string'
    || log.topics[0].replace(/^0x/i, '').toLowerCase() !== TRANSFER_EVENT_TOPIC) return null
  const fromBytes = canonicalTopicAddress(log.topics[1])
  const toBytes = canonicalTopicAddress(log.topics[2])
  const data = typeof log.data === 'string' ? log.data.replace(/^0x/i, '') : ''
  if (!fromBytes || !toBytes || !/^[0-9a-fA-F]{64}$/.test(data)) return null
  try {
    return {
      fromBytes,
      toBytes,
      amountBaseUnits: BigInt('0x' + data).toString(),
    }
  } catch {
    return null
  }
}

/**
 * Verify a direct TRC-20 transfer against TRON's SolidityNode transaction body
 * and solidified receipt. This is verification-only: it never signs, submits,
 * broadcasts, reserves sponsor budget, or infers exchange credit.
 */
export function createTRC20VerificationRouter({
  env = process.env,
  fetchImpl = globalThis.fetch,
  tronWebFactory = async (host) => {
    const { TronWeb } = await import('tronweb')
    return new TronWeb({ fullHost: host })
  },
  persistVerification = recordTransferVerification,
  timeoutMs = 8000,
} = {}) {
  const router = Router()

  router.get('/verify-trc20-transfer/:hash', async (req, res) => {
    res.setHeader?.('Cache-Control', 'no-store')
    res.setHeader?.('Pragma', 'no-cache')

    const hash = req.params?.hash
    const { network, contract, from, to, amountBaseUnits, eventIndex: eventIndexText } = req.query || {}
    if (typeof hash !== 'string' || !TX_PATTERN.test(hash)) {
      return res.status(400).json({ success: false, verified: false, error: 'invalid-transaction-id' })
    }
    if (typeof network !== 'string' || !Object.hasOwn(NETWORKS, network)) {
      return res.status(400).json({ success: false, verified: false, error: 'invalid-network', message: 'network must be mainnet, shasta, or nile.' })
    }
    if (![contract, from, to].every((value) => typeof value === 'string' && ADDRESS_PATTERN.test(value))) {
      return res.status(400).json({ success: false, verified: false, error: 'invalid-address', message: 'contract, from and to must be valid TRON Base58 addresses.' })
    }
    if (typeof amountBaseUnits !== 'string' || !BASE_UNITS_PATTERN.test(amountBaseUnits)
      || BigInt(amountBaseUnits) > UINT256_MAX) {
      return res.status(400).json({ success: false, verified: false, error: 'invalid-amount', message: 'amountBaseUnits must be a positive uint256 decimal string.' })
    }
    let eventIndex = null
    if (eventIndexText !== undefined) {
      if (typeof eventIndexText !== 'string' || !/^(0|[1-9][0-9]{0,5})$/.test(eventIndexText)) {
        return res.status(400).json({ success: false, verified: false, error: 'invalid-event-index', message: 'eventIndex must be a zero-based solidified receipt-log index.' })
      }
      eventIndex = Number(eventIndexText)
    }

    try {
      const tronWeb = await tronWebFactory(NETWORKS[network])
      const contractBytes = canonicalBase58Address(tronWeb, contract)
      const fromBytes = canonicalBase58Address(tronWeb, from)
      const toBytes = canonicalBase58Address(tronWeb, to)
      if (!contractBytes || !fromBytes || !toBytes) {
        return res.status(400).json({ success: false, verified: false, error: 'invalid-address-checksum' })
      }

      const headers = { accept: 'application/json', 'content-type': 'application/json' }
      if (typeof env.TRONGRID_API_KEY === 'string' && env.TRONGRID_API_KEY.trim()) {
        headers['TRON-PRO-API-KEY'] = env.TRONGRID_API_KEY.trim()
      }
      const query = async (path) => {
        const response = await fetchImpl(NETWORKS[network] + path, {
          method: 'POST',
          redirect: 'error',
          headers,
          body: JSON.stringify({ value: hash, visible: false }),
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!response.ok) throw new Error('solidified-provider-unavailable')
        const payload = await response.json()
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid-solidified-provider-response')
        return payload
      }

      const [transaction, receipt] = await Promise.all([
        query('/walletsolidity/gettransactionbyid'),
        query('/walletsolidity/gettransactioninfobyid'),
      ])
      const bodyMatches = typeof transaction?.txID === 'string' && transaction.txID.toLowerCase() === hash.toLowerCase()
      const receiptMatches = typeof receipt?.id === 'string' && receipt.id.toLowerCase() === hash.toLowerCase()
      const hasSolidifiedReceipt = receiptMatches && Number.isSafeInteger(receipt.blockNumber) && receipt.blockNumber >= 0
      if (!bodyMatches || !hasSolidifiedReceipt) {
        return res.status(202).json({
          success: true,
          verified: false,
          status: 'awaiting-solidified-receipt',
          network,
          transactionId: hash,
          solidifiedReceiptPresent: false,
          canSubmitSponsoredTransfer: false,
          submissionEnabled: false,
          message: 'The exact transaction body and solidified receipt are not both available yet. Retry this same transaction ID; do not create a replacement transfer while the result is uncertain.',
        })
      }

      const transactionContracts = Array.isArray(transaction?.raw_data?.contract) ? transaction.raw_data.contract : []
      const trigger = transactionContracts.find((item) => item?.type === 'TriggerSmartContract')
      const value = trigger?.parameter?.value
      const actualSenderBytes = canonicalHexAddress(value?.owner_address)
      const actualContractBytes = canonicalHexAddress(value?.contract_address)
      const calldata = typeof value?.data === 'string' ? value.data.replace(/^0x/i, '').toLowerCase() : ''
      const calldataMatch = new RegExp('^' + TRANSFER_SELECTOR + '([0-9a-f]{128})$').exec(calldata)
      const encodedReceiverBytes = calldataMatch ? calldataMatch[1].slice(24, 64) : null
      let encodedAmountBaseUnits = null
      if (calldataMatch) {
        try { encodedAmountBaseUnits = BigInt('0x' + calldataMatch[1].slice(64, 128)).toString() } catch {}
      }

      const transactionSucceeded = transaction?.ret?.some((item) => item?.contractRet === 'SUCCESS') === true
      const receiptSucceeded = receipt?.receipt?.result === 'SUCCESS'
      const logs = Array.isArray(receipt?.log) ? receipt.log : []
      const matchingEvents = []
      for (let index = 0; index < logs.length; index += 1) {
        if (eventIndex !== null && index !== eventIndex) continue
        const transfer = readTransferLog(logs[index], contractBytes)
        if (!transfer) continue
        if (transfer.fromBytes === fromBytes && transfer.toBytes === toBytes && transfer.amountBaseUnits === amountBaseUnits) {
          matchingEvents.push({ eventIndex: index, ...transfer })
        }
      }
      const uniqueEvent = matchingEvents.length === 1 ? matchingEvents[0] : null
      const checks = {
        transactionBodyMatches: bodyMatches,
        solidifiedReceiptPresent: hasSolidifiedReceipt,
        executionSucceeded: transactionSucceeded && receiptSucceeded,
        directTokenTransferCall: Boolean(calldataMatch),
        tokenContractMatches: actualContractBytes === contractBytes,
        senderMatches: actualSenderBytes === fromBytes,
        receiverMatches: encodedReceiverBytes === toBytes,
        amountMatches: encodedAmountBaseUnits === amountBaseUnits,
        transferEventMatches: Boolean(uniqueEvent),
        eventNotAmbiguous: matchingEvents.length === 1,
      }
      const verified = Object.values(checks).every(Boolean)
      const status = !transactionSucceeded || !receiptSucceeded
        ? 'solidified-transaction-failed'
        : verified ? 'solidified-trc20-transfer-verified'
          : matchingEvents.length > 1 ? 'ambiguous-matching-transfer-event' : 'solidified-transfer-mismatch'

      let verificationPersistence = { persisted: false, reason: 'transfer-not-verified' }
      if (verified && uniqueEvent) {
        try {
          verificationPersistence = await persistVerification({
            network,
            transactionHash: hash,
            tokenContract: contract,
            fromAddress: from,
            toAddress: to,
            amountBaseUnits,
            status: 'verified-on-chain',
            logIndex: uniqueEvent.eventIndex,
            result: {
              blockNumber: receipt.blockNumber,
              timestamp: Number.isSafeInteger(receipt.blockTimeStamp) ? receipt.blockTimeStamp : null,
              receiptResult: receipt?.receipt?.result,
              transactionResult: transaction?.ret?.[0]?.contractRet || null,
              eventIndex: uniqueEvent.eventIndex,
              source: 'TRON SolidityNode transaction body, receipt and exact Transfer event',
            },
          })
        } catch {
          verificationPersistence = { persisted: false, reason: 'database-persistence-failed' }
        }
      }

      return res.status(200).json({
        success: true,
        verified,
        status,
        network,
        transactionId: hash,
        blockNumber: receipt.blockNumber,
        timestamp: receipt.blockTimeStamp ?? null,
        verificationPersistence,
        contract,
        assetIdentity: network === 'mainnet' && contract === OFFICIAL_MAINNET_USDT
          ? 'official-mainnet-usdt-contract'
          : 'specific-trc20-contract-only',
        from,
        to,
        amountBaseUnits,
        ...(uniqueEvent ? { eventIndex: uniqueEvent.eventIndex } : eventIndex !== null ? { eventIndex } : {}),
        checks,
        source: 'TRON SolidityNode transaction body, receipt and exact Transfer event',
        canSubmitSponsoredTransfer: false,
        submissionEnabled: false,
        transactionBroadcast: false,
        unpaidFallbackToUserFunds: false,
        note: 'This verifies only the specified direct TRC-20 transfer on the selected chain. Persisted history is recorded separately when database persistence succeeds. This does not enable sending or prove an exchange account has credited a deposit.',
        checkedAt: new Date().toISOString(),
      })
    } catch {
      return res.status(502).json({
        success: false,
        verified: false,
        error: 'solidified-verification-unavailable',
        network,
        message: 'Could not verify the transaction from the selected network. No transfer was submitted; retry later with the same transaction ID.',
      })
    }
  })

  return router
}

export default createTRC20VerificationRouter()
