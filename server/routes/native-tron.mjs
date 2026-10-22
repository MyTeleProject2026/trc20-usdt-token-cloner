import { recordNativeTransferVerification, listPersistedReceiverHistory, registerTrackedWallet } from '../database.mjs'
import { timingSafeEqual } from 'node:crypto'

import { Router } from 'express'

const router = Router()
const txPattern = /^[0-9a-fA-F]{64}$/
const networks = {
  shasta: 'https://api.shasta.trongrid.io',
  nile: 'https://nile.trongrid.io',
  mainnet: 'https://api.trongrid.io',
}
const addressPattern = /^T[1-9A-HJ-NP-Za-km-z]{33}$/

// Read-only sponsorship capability status. This API deliberately fails closed:
// provider onboarding, signer authorization, limits, and fee/asset reconciliation
// are not yet complete, so environment variables cannot accidentally enable sends.
router.get('/sponsorship/status', (_req, res) => {
  return res.json({
    success: true,
    sponsorship: {
      enabled: false,
      mainnetEnabled: false,
      canSubmitSponsoredTransfer: false,
      network: null,
      provider: null,
      receiverRestrictionsAvailable: false,
      receiverBalance: {
        source: 'verified-on-chain-only',
        displayOnlySponsorCredit: false,
        spendableSource: 'on-chain-wallet-balance',
        sponsorAssetGrantEnabled: false,
        sponsoredFeeCoverage: 'none',
        exchangeCredit: 'exchange-confirmation-required',
      },
      message: 'Sponsored transfers are disabled. No verified provider authorization, signer controls, funding checks, limits, or end-to-end reconciliation gate is active.',
      requiredBeforeEnablement: [
        'verified-provider-adapter-and-account',
        'explicit-sponsor-consent-and-funded-budget',
        'server-side-authorization-and-per-transfer-limits',
        'idempotent-sponsor-ledger-and-reconciliation',
        'testnet-end-to-end-and-security-review',
        'verified-provider-onboarding-and-terms',
        'provider-specific-signing-authorization',
        'independent-network-and-token-contract-allowlist',
        'funding-and-budget-reservation-enforced-server-side',
        'network-fee-and-asset-principal-reconciled-separately',
        'finalized-on-chain-evidence-and-idempotent-ledger-transitions',
        'audit-log-and-abuse-rate-limits',
        'end-to-end-testnet-validation-and-security-review',
      ],
    },
    limitations: [
      'This endpoint reports capability status only; it never authorizes or submits a transfer.',
      'An on-chain confirmation does not guarantee an exchange will credit a deposit.',
    ],
  })
})

// Keep SUN conversion exact; native balances can exceed Number's safe integer range.
const formatSun = (value) => {
  const sun = BigInt(value)
  const whole = sun / 1_000_000n
  const fraction = (sun % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

// Read a receiver's native TRX balance from the selected network's solidified state.
router.get('/native-balance', async (req, res) => {
  const { network, address } = req.query
  if (typeof network !== 'string' || !Object.hasOwn(networks, network)) {
    return res.status(400).json({ success: false, error: 'invalid-network', message: 'network must be mainnet, shasta, or nile.' })
  }
  if (typeof address !== 'string' || !addressPattern.test(address)) {
    return res.status(400).json({ success: false, error: 'invalid-address', message: 'Provide a valid TRON Base58 receiver address.' })
  }
  try {
    const { TronWeb } = await import('tronweb')
    const tronWeb = new TronWeb({ fullHost: networks[network] })
    if (!tronWeb.isAddress(address)) return res.status(400).json({ success: false, error: 'invalid-address' })
    const headers = { 'content-type': 'application/json' }
    if (process.env.TRONGRID_API_KEY) headers['TRON-PRO-API-KEY'] = process.env.TRONGRID_API_KEY
    const response = await fetch(networks[network] + '/walletsolidity/getaccount', {
      method: 'POST', headers,
      body: JSON.stringify({ address: tronWeb.address.toHex(address), visible: false }),
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) throw new Error('solidified-provider-unavailable')
    const account = await response.json()
    const balanceSun = String(account?.balance ?? 0)
    if (!/^[0-9]+$/.test(balanceSun)) throw new Error('invalid-solidified-balance')
    return res.json({
      success: true,
      status: 'solidified-native-balance-read',
      network,
      address,
      accountExists: Boolean(account?.address),
      balanceSun,
      balanceTRX: formatSun(balanceSun),
      source: 'TRON SolidityNode getaccount',
      note: 'This is native TRX on the selected network only. It does not query TRC20 tokens or confirm exchange deposit credit.',
    })
  } catch {
    return res.status(502).json({ success: false, error: 'solidified-native-balance-read-failed', message: 'Could not read native TRX balance from the selected network solidified state.' })
  }
})

// Read-only verification for native TRX transfers. Both the transaction body
// and receipt must be visible from the selected network's solidified node.
router.get('/verify-native-transfer/:hash', async (req, res) => {
  const { hash } = req.params
  const { network, from, to, amountSun } = req.query

  if (!txPattern.test(hash)) {
    return res.status(400).json({ success: false, verified: false, error: 'invalid-transaction-id' })
  }
  if (typeof network !== 'string' || !Object.hasOwn(networks, network)) {
    return res.status(400).json({ success: false, verified: false, error: 'invalid-network', message: 'network must be mainnet, shasta, or nile.' })
  }

  const hasExpectedFields = from !== undefined || to !== undefined || amountSun !== undefined
  if (hasExpectedFields && !(typeof from === 'string' && typeof to === 'string' && typeof amountSun === 'string')) {
    return res.status(400).json({ success: false, verified: false, error: 'incomplete-expected-transfer', message: 'When checking expected values, provide from, to, and amountSun together.' })
  }
  if (hasExpectedFields && (!addressPattern.test(from) || !addressPattern.test(to) || !/^[0-9]+$/.test(amountSun) || BigInt(amountSun) <= 0n)) {
    return res.status(400).json({ success: false, verified: false, error: 'invalid-expected-transfer', message: 'Use valid TRON Base58 addresses and a positive amountSun integer; 1 TRX = 1000000 sun.' })
  }

  try {
    const { TronWeb } = await import('tronweb')
    const tronWeb = new TronWeb({ fullHost: networks[network] })
    if (hasExpectedFields && (!tronWeb.isAddress(from) || !tronWeb.isAddress(to))) {
      return res.status(400).json({ success: false, verified: false, error: 'invalid-expected-address' })
    }
    const expectedFrom = hasExpectedFields ? tronWeb.address.toHex(from).replace(/^0x/i, '').toLowerCase() : null
    const expectedTo = hasExpectedFields ? tronWeb.address.toHex(to).replace(/^0x/i, '').toLowerCase() : null
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
        message: 'The solidified transaction body and receipt are not both available yet. Retry this same transaction ID; do not send another transfer just because this one is pending.',
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
      executionSucceeded: contractResult === 'SUCCESS',
      solidifiedReceiptPresent: receipt.id?.toLowerCase() === hash.toLowerCase() && Number.isInteger(receipt.blockNumber),
      ...(hasExpectedFields ? {
        senderMatches: actualFrom === expectedFrom,
        receiverMatches: actualTo === expectedTo,
        amountMatches: actualAmountSun === amountSun,
      } : {}),
    }
    const verified = Boolean(contract) && contractResult === 'SUCCESS' &&
      checks.solidifiedReceiptPresent &&
      (!hasExpectedFields || (checks.senderMatches && checks.receiverMatches && checks.amountMatches))

    let senderAddress = value?.owner_address ?? null
    let receiverAddress = value?.to_address ?? null
    try {
      if (senderAddress && /^[0-9a-fA-F]{42}$/.test(senderAddress)) senderAddress = tronWeb.address.fromHex(senderAddress)
      if (receiverAddress && /^[0-9a-fA-F]{42}$/.test(receiverAddress)) receiverAddress = tronWeb.address.fromHex(receiverAddress)
    } catch { /* Preserve provider-returned address if conversion is unsupported. */ }

    let verificationPersistence = { persisted: false, reason: 'transfer-not-verified' }
    if (verified && senderAddress && receiverAddress && actualAmountSun && Number.isSafeInteger(receipt.blockNumber)) {
      try {
        verificationPersistence = await recordNativeTransferVerification({
          network,
          transactionHash: hash,
          fromAddress: senderAddress,
          toAddress: receiverAddress,
          amountSun: actualAmountSun,
          blockNumber: receipt.blockNumber,
        })
      } catch {
        verificationPersistence = { persisted: false, reason: 'database-persistence-failed' }
      }
    }

    return res.json({
      success: true,
      verified,
      verificationPersistence,
      status: verified ? 'solidified-transfer-verified' : 'solidified-transfer-mismatch-or-failed',
      network,
      transactionId: hash,
      blockNumber: receipt.blockNumber,
      timestamp: receipt.blockTimeStamp ?? null,
      from: senderAddress,
      to: receiverAddress,
      amountSun: actualAmountSun,
      amountTRX: actualAmountSun === null ? null : formatSun(actualAmountSun),
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



/** Read persisted worker results separately from the live indexer feed. */
router.get('/receiver-history/persisted', async (req, res) => {
  const { network, address, contract } = req.query
  const limitValue = req.query.limit === undefined ? '50' : req.query.limit
  const limit = Number(limitValue)
  if (typeof network !== 'string' || !Object.hasOwn(networks, network)) {
    return res.status(400).json({ success: false, error: 'invalid-network' })
  }
  if (typeof address !== 'string' || !addressPattern.test(address)) {
    return res.status(400).json({ success: false, error: 'invalid-address' })
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    return res.status(400).json({ success: false, error: 'invalid-limit', message: 'limit must be an integer from 1 to 50.' })
  }
  if (contract !== undefined && (typeof contract !== 'string' || !addressPattern.test(contract))) {
    return res.status(400).json({ success: false, error: 'invalid-contract' })
  }
  try {
    const result = await listPersistedReceiverHistory({ network, address, contract: contract || null, limit })
    if (!result.success) {
      if (result.reason === 'invalid-query') return res.status(400).json({ success: false, error: 'invalid-query' })
      return res.status(503).json({ success: false, error: 'persisted-history-unavailable', reason: result.reason })
    }
    return res.json({
      success: true,
      status: 'persisted-receiver-history',
      network,
      address,
      count: result.records.length,
      records: result.records,
      source: 'TRON Token Studio receiver-history database',
      note: 'Persisted records are only verified when verifiedOnChain is true and verificationStatus is verified-on-chain. This does not establish exchange deposit credit.',
    })
  } catch {
    return res.status(503).json({ success: false, error: 'persisted-history-unavailable', message: 'Persisted receiver history is temporarily unavailable.' })
  }
})


function hasValidWatchlistAdminToken(req) {
  const configured = process.env.RECEIVER_WATCHLIST_ADMIN_TOKEN
  const authorization = req.headers.authorization
  if (typeof configured !== 'string' || configured.length < 32
    || typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false
  const supplied = Buffer.from(authorization.slice(7))
  const expected = Buffer.from(configured)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

// Watchlist changes are privileged: never allow anonymous callers to enroll
// arbitrary addresses into persistent polling. Configure a server-only token
// of at least 32 characters before using this administrative endpoint.
router.post('/tracked-wallets', async (req, res) => {
  if (!process.env.RECEIVER_WATCHLIST_ADMIN_TOKEN || process.env.RECEIVER_WATCHLIST_ADMIN_TOKEN.length < 32) {
    return res.status(503).json({ success: false, error: 'watchlist-registration-not-configured', message: 'Protected receiver registration is not configured on this server.' })
  }
  if (!hasValidWatchlistAdminToken(req)) {
    return res.status(401).json({ success: false, error: 'unauthorized', message: 'A valid watchlist administrator token is required.' })
  }
  const { network, address, displayLabel } = req.body || {}
  if (typeof network !== 'string' || !Object.hasOwn(networks, network)) {
    return res.status(400).json({ success: false, error: 'invalid-network', message: 'network must be mainnet, shasta, or nile.' })
  }
  if (typeof address !== 'string' || !addressPattern.test(address)) {
    return res.status(400).json({ success: false, error: 'invalid-address', message: 'Provide a valid TRON Base58 receiver address.' })
  }
  if (displayLabel !== undefined && (typeof displayLabel !== 'string' || displayLabel.trim().length > 80)) {
    return res.status(400).json({ success: false, error: 'invalid-display-label', message: 'displayLabel must be a string no longer than 80 characters.' })
  }
  try {
    const { TronWeb } = await import('tronweb')
    const tronWeb = new TronWeb({ fullHost: networks[network] })
    if (!tronWeb.isAddress(address)) return res.status(400).json({ success: false, error: 'invalid-address' })
    const result = await registerTrackedWallet({
      network,
      address,
      displayLabel: typeof displayLabel === 'string' ? displayLabel.trim() || null : null,
    })
    if (!result.success) return res.status(503).json({ success: false, error: 'watchlist-registration-unavailable', reason: result.reason })
    return res.status(result.created ? 201 : 200).json({
      success: true,
      status: result.created ? 'receiver-registered-for-monitoring' : 'receiver-already-registered',
      network,
      address,
      created: result.created,
      monitoring: 'pending-worker-schedule',
      note: 'Registration adds this address to the server watchlist only. Monitoring runs only when the separately configured worker is enabled and scheduled.',
    })
  } catch {
    return res.status(503).json({ success: false, error: 'watchlist-registration-unavailable', message: 'Could not register this receiver for monitoring.' })
  }
})

// Read-only incoming TRC-20 indexer feed. Indexer rows are candidates only;
// they are not final settlement evidence until solidified transaction/receipt
// verification succeeds in the existing verification endpoint.
router.get('/receiver-history', async (req, res) => {
  const { network, address, contract, fingerprint } = req.query
  const limitValue = req.query.limit === undefined ? '20' : req.query.limit
  const limit = Number(limitValue)
  // TRONGrid supplies opaque pagination fingerprints. Bound and validate the
  // token before forwarding it; callers cannot choose an upstream URL.
  if (fingerprint !== undefined && (typeof fingerprint !== 'string'
    || fingerprint.length < 1 || fingerprint.length > 512
    || !/^[A-Za-z0-9_=-]+$/.test(fingerprint))) {
    return res.status(400).json({ success: false, error: 'invalid-fingerprint', message: 'fingerprint must be a valid bounded TRONGrid pagination token.' })
  }
  if (typeof network !== 'string' || !Object.hasOwn(networks, network)) {
    return res.status(400).json({ success: false, error: 'invalid-network', message: 'network must be mainnet, shasta, or nile.' })
  }
  if (typeof address !== 'string' || !addressPattern.test(address)) {
    return res.status(400).json({ success: false, error: 'invalid-address', message: 'Provide a valid TRON Base58 receiver address.' })
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    return res.status(400).json({ success: false, error: 'invalid-limit', message: 'limit must be an integer from 1 to 50.' })
  }
  try {
    const { TronWeb } = await import('tronweb')
    const tronWeb = new TronWeb({ fullHost: networks[network] })
    if (!tronWeb.isAddress(address)) return res.status(400).json({ success: false, error: 'invalid-address' })
    if (contract !== undefined && (typeof contract !== 'string' || !tronWeb.isAddress(contract))) {
      return res.status(400).json({ success: false, error: 'invalid-contract', message: 'contract must be a valid TRON Base58 token contract address.' })
    }
    const query = new URLSearchParams({
      only_confirmed: 'true',
      only_to: 'true',
      limit: String(limit),
      order_by: 'block_timestamp,desc',
    })
    if (typeof contract === 'string' && contract) query.set('contract_address', contract)
    if (typeof fingerprint === 'string') query.set('fingerprint', fingerprint)
    const headers = { accept: 'application/json' }
    if (process.env.TRONGRID_API_KEY) headers['TRON-PRO-API-KEY'] = process.env.TRONGRID_API_KEY
    const response = await fetch(`${networks[network]}/v1/accounts/${encodeURIComponent(address)}/transactions/trc20?${query.toString()}`, {
      headers,
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) {
      return res.status(502).json({ success: false, error: 'history-provider-unavailable', providerStatus: response.status, message: 'The selected network history indexer is unavailable; no empty history is implied.' })
    }
    const payload = await response.json()
    if (!Array.isArray(payload?.data)) throw new Error('invalid-indexer-response')
    const records = payload.data.map((item) => ({
      transactionId: item.transaction_id || item.txID || null,
      network,
      receiverAddress: item.to || address,
      senderAddress: item.from || null,
      tokenContract: item.token_info?.address || item.contract_address || null,
      tokenName: item.token_info?.name || null,
      tokenSymbol: item.token_info?.symbol || null,
      tokenDecimals: Number.isInteger(Number(item.token_info?.decimals)) ? Number(item.token_info.decimals) : null,
      amountBaseUnits: typeof item.value === 'string' || typeof item.value === 'number' ? String(item.value) : null,
      timestamp: Number.isFinite(Number(item.block_timestamp)) ? Number(item.block_timestamp) : null,
      eventIndex: item.event_index ?? item.eventIndex ?? null,
      indexedConfirmed: item.block_timestamp !== undefined,
      verificationStatus: 'indexed-candidate-awaiting-solidified-verification',
      verifiedOnChain: false,
    }))
    return res.json({
      success: true,
      status: 'indexed-candidates-not-finalized',
      network,
      address,
      contract: typeof contract === 'string' ? contract : null,
      count: records.length,
      nextFingerprint: payload?.meta?.fingerprint || null,
      records,
      source: 'TRONGrid confirmed TRC-20 history indexer',
      note: 'These indexed incoming records are candidates, not final settlement proof. Verify each transaction against the selected network solidified transaction body, receipt, exact contract and Transfer event before displaying it as fully verified. Wallet/exchange UI and exchange credit are controlled by the receiving platform.',
    })
  } catch {
    return res.status(502).json({ success: false, error: 'receiver-history-unavailable', message: 'Could not safely read incoming TRC-20 history from the selected network.' })
  }
})

export default router
