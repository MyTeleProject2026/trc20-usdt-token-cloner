import { Router } from 'express'

const router = Router()
const txPattern = /^[0-9a-fA-F]{64}$/
const networks = {
  shasta: 'https://api.shasta.trongrid.io',
  nile: 'https://nile.trongrid.io',
  mainnet: 'https://api.trongrid.io',
}
const addressPattern = /^T[1-9A-HJ-NP-Za-km-z]{33}$/

// Read-only verification for native TRX transfers. A result is verified only
// when both transaction body and receipt are visible from the solidified node.
router.get('/verify-native-transfer/:hash', async (req, res) => {
  const { hash } = req.params
  const { network, from, to, amountSun } = req.query

  if (!txPattern.test(hash)) {
    return res.status(400).json({ success: false, verified: false, error: 'invalid-transaction-id' })
  }
  if (typeof network !== 'string' || !Object.hasOwn(networks, network)) {
    return res.status(400).json({ success: false, verified: false, error: 'invalid-network', message: 'network must be mainnet, shasta, or nile.' })
  }
  if (typeof from !== 'string' || typeof to !== 'string' || !addressPattern.test(from) || !addressPattern.test(to)) {
    return res.status(400).json({ success: false, verified: false, error: 'invalid-address', message: 'from and to must be valid TRON Base58 addresses.' })
  }
  if (typeof amountSun !== 'string' || !/^[0-9]+$/.test(amountSun) || BigInt(amountSun) <= 0n) {
    return res.status(400).json({ success: false, verified: false, error: 'invalid-amount', message: 'amountSun must be a positive integer in sun; 1 TRX = 1000000 sun.' })
  }

  try {
    const { TronWeb } = await import('tronweb')
    const tronWeb = new TronWeb({ fullHost: networks[network] })
    if (!tronWeb.isAddress(from) || !tronWeb.isAddress(to)) {
      return res.status(400).json({ success: false, verified: false, error: 'invalid-address' })
    }
    const expectedFrom = tronWeb.address.toHex(from).replace(/^0x/i, '').toLowerCase()
    const expectedTo = tronWeb.address.toHex(to).replace(/^0x/i, '').toLowerCase()
    const headers = { 'content-type': 'application/json' }
    if (process.env.TRONGRID_API_KEY) headers['TRON-PRO-API-KEY'] = process.env.TRONGRID_API_KEY

    const query = async (path) => {
      const response = await fetch(networks[network] + path, {
        method: 'POST',
        headers,
        body: JSON.stringify({ value: hash, visible: false }),
        signal: AbortSignal.timeout(8000),
      })
      if (!response.ok) throw new Error('provider-unavailable')
      return response.json()
    }

    const [transaction, receipt] = await Promise.all([
      query('/walletsolidity/gettransactionbyid'),
      query('/walletsolidity/gettransactioninfobyid'),
    ])
    if (transaction?.txID?.toLowerCase() !== hash.toLowerCase() || receipt?.id?.toLowerCase() !== hash.toLowerCase() || !Number.isInteger(receipt?.blockNumber)) {
      return res.status(202).json({
        success: true,
        verified: false,
        status: 'awaiting-solidification',
        network,
        transactionId: hash,
        message: 'The solidified transaction body and receipt are not both available yet. Retry this same transaction ID; do not send again just because it is pending.',
      })
    }

    const contract = transaction.raw_data?.contract?.find((item) => item.type === 'TransferContract')
    const value = contract?.parameter?.value
    const actualFrom = String(value?.owner_address || '').replace(/^0x/i, '').toLowerCase()
    const actualTo = String(value?.to_address || '').replace(/^0x/i, '').toLowerCase()
    const actualAmountSun = value?.amount === undefined ? null : String(value.amount)
    const contractResult = transaction.ret?.[0]?.contractRet || null
    const checks = {
      nativeTransfer: Boolean(contract),
      senderMatches: actualFrom === expectedFrom,
      receiverMatches: actualTo === expectedTo,
      amountMatches: actualAmountSun === amountSun,
      executionSucceeded: contractResult === 'SUCCESS',
      solidifiedReceiptPresent: receipt.id?.toLowerCase() === hash.toLowerCase() && Number.isInteger(receipt.blockNumber),
    }
    const verified = Object.values(checks).every(Boolean)

    return res.json({
      success: true,
      verified,
      status: verified ? 'solidified-transfer-verified' : 'solidified-transfer-mismatch-or-failed',
      network,
      transactionId: hash,
      blockNumber: receipt.blockNumber,
      timestamp: receipt.blockTimeStamp ?? null,
      from: value?.owner_address ?? null,
      to: value?.to_address ?? null,
      amountSun: actualAmountSun,
      amountTRX: actualAmountSun === null ? null : (Number(actualAmountSun) / 1_000_000).toString(),
      contractResult,
      checks,
      source: 'TRON SolidityNode transaction body and receipt',
      note: 'This verifies native TRX on-chain only; it does not verify any TRC20 token balance or exchange deposit credit.',
    })
  } catch {
    return res.status(502).json({
      success: false,
      verified: false,
      error: 'solidified-verification-unavailable',
      message: 'Could not query the selected TRON network. Retry later with the same transaction ID.',
    })
  }
})

export default router
