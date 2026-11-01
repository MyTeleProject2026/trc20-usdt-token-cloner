import { createHash } from 'node:crypto'
import { Router } from 'express'
import { TronWeb } from 'tronweb'
import {
  getWalletAuthSession,
  getLatestFireblocksInventorySnapshot,
  persistThirdPartyFundingAuthorization,
  getThirdPartyFundingAuthorization,
  listThirdPartyFundingAuthorizations,
  persistThirdPartyFundingDeposit,
  markThirdPartyFundingDepositFireblocksVerified,
  revokeThirdPartyFundingAuthorization,
} from '../database.mjs'
import {
  buildThirdPartyFundingAuthorizationMessage,
  verifyThirdPartyFundingAuthorization,
  OFFICIAL_TRON_MAINNET_USDT,
} from '../../src/third-party-funding-authorization.mjs'
import { isValidTronAddress } from '../tron-address.mjs'

const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const TXID_PATTERN = /^[0-9a-f]{64}$/i
const AUTHORIZATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{3,127}$/
const TRANSFER_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const MAX_INVENTORY_AGE_MS = 6 * 60 * 60 * 1000
const REQUIRED_INVENTORY_CHECKS = [
  'fireblocksApiAuthenticated', 'vaultAccountVerified', 'usdtAssetActivated',
  'officialUsdtAssetVerified', 'usdtAddressMatches', 'trxAssetActivated',
  'nativeTrxAssetVerified', 'trxAddressMatches', 'officialUsdtChainVerified',
  'treasuryTrxChainBalanceRead', 'databaseReady',
]

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function header(req, name) {
  const value = typeof req.get === 'function' ? req.get(name) : req.headers?.[name.toLowerCase()]
  return typeof value === 'string' ? value : ''
}

function normalizedHex(value) {
  return typeof value === 'string' ? value.replace(/^0x/i, '').toLowerCase() : ''
}

function validDigits(value, { positive = false } = {}) {
  return typeof value === 'string'
    && (positive ? /^[1-9][0-9]{0,77}$/ : /^(0|[1-9][0-9]{0,77})$/).test(value)
}

function normalizeAddressHex(tronWeb, address) {
  try {
    const value = normalizedHex(tronWeb.address.toHex(address))
    return /^41[0-9a-f]{40}$/.test(value) ? value : ''
  } catch {
    return ''
  }
}

function solidifiedReceiptMatches(transaction, transactionInfo, transactionHash) {
  const txid = String(transaction?.txID || transaction?.txid || '').toLowerCase()
  const infoId = String(transactionInfo?.id || transactionInfo?.txID || transactionInfo?.txid || '').toLowerCase()
  if (!TXID_PATTERN.test(transactionHash || '') || txid !== transactionHash.toLowerCase()
    || infoId !== transactionHash.toLowerCase()) {
    return { verified: false, reason: 'solidified-transaction-or-receipt-not-found' }
  }
  if (!Number.isSafeInteger(transactionInfo?.blockNumber) || transactionInfo.blockNumber < 1) {
    return { verified: false, reason: 'transaction-not-in-solidified-block' }
  }
  if (transactionInfo?.receipt?.result !== 'SUCCESS') {
    return { verified: false, reason: 'solidified-receipt-not-successful' }
  }
  const results = Array.isArray(transaction?.ret)
    ? transaction.ret.map((item) => item?.contractRet).filter((value) => typeof value === 'string')
    : []
  if (results.length !== 1 || results[0] !== 'SUCCESS') {
    return { verified: false, reason: 'solidified-transaction-execution-result-mismatch' }
  }
  return { verified: true, blockNumber: transactionInfo.blockNumber }
}

/**
 * Verify a third-party USDT deposit using the confirmed transaction body and
 * solidified receipt. The transaction call data and exact official Tether
 * Transfer event must agree on sender, recipient and base-unit amount.
 */
export function verifyThirdPartyUsdtDepositEvidence(tronWeb, {
  transaction,
  transactionInfo,
  transactionHash,
  sponsorAddress,
  vaultAddress,
  maxUsdtBaseUnits,
} = {}) {
  if (!tronWeb?.address?.toHex || !ADDRESS_PATTERN.test(sponsorAddress || '')
    || !ADDRESS_PATTERN.test(vaultAddress || '')
    || !validDigits(maxUsdtBaseUnits, { positive: true })) {
    return { verified: false, reason: 'invalid-usdt-deposit-verification-input' }
  }
  const solidified = solidifiedReceiptMatches(transaction, transactionInfo, transactionHash)
  if (!solidified.verified) return solidified

  const contracts = transaction?.raw_data?.contract
  if (!Array.isArray(contracts) || contracts.length !== 1 || contracts[0]?.type !== 'TriggerSmartContract') {
    return { verified: false, reason: 'unexpected-usdt-deposit-operation' }
  }
  const expectedSponsor = normalizeAddressHex(tronWeb, sponsorAddress)
  const expectedVault = normalizeAddressHex(tronWeb, vaultAddress)
  const expectedContract = normalizeAddressHex(tronWeb, OFFICIAL_TRON_MAINNET_USDT)
  const value = contracts[0]?.parameter?.value
  if (!expectedSponsor || !expectedVault || !expectedContract
    || normalizedHex(value?.owner_address) !== expectedSponsor
    || normalizedHex(value?.contract_address) !== expectedContract) {
    return { verified: false, reason: 'usdt-deposit-source-or-contract-mismatch' }
  }

  const callData = normalizedHex(value?.data)
  if (!/^a9059cbb[0-9a-f]{128}$/.test(callData)) {
    return { verified: false, reason: 'usdt-deposit-transfer-calldata-invalid' }
  }
  const requestedRecipient = callData.slice(8, 72)
  const requestedAmount = BigInt('0x' + callData.slice(72, 136)).toString()
  const expectedRecipient = expectedVault.slice(2).padStart(64, '0')
  if (requestedRecipient !== expectedRecipient || !validDigits(requestedAmount, { positive: true })
    || BigInt(requestedAmount) > BigInt(maxUsdtBaseUnits)) {
    return { verified: false, reason: 'usdt-deposit-calldata-recipient-or-amount-mismatch' }
  }

  const contractAddress = expectedContract.slice(2)
  const fromTopic = expectedSponsor.slice(2).padStart(64, '0')
  const toTopic = expectedRecipient
  const logs = Array.isArray(transactionInfo?.log) ? transactionInfo.log : []
  const transferLogs = logs.map((log, index) => ({ log, index })).filter(({ log }) =>
    normalizedHex(log?.address).replace(/^41(?=[0-9a-f]{40}$)/, '') === contractAddress
      && Array.isArray(log?.topics) && normalizedHex(log.topics[0]) === TRANSFER_TOPIC)
  const exactLogs = transferLogs.filter(({ log }) =>
    log.topics.length >= 3
      && normalizedHex(log.topics[1]).padStart(64, '0') === fromTopic
      && normalizedHex(log.topics[2]).padStart(64, '0') === toTopic
      && normalizedHex(log.data).padStart(64, '0') === BigInt(requestedAmount).toString(16).padStart(64, '0'))
  if (transferLogs.length !== 1 || exactLogs.length !== 1) {
    return { verified: false, reason: 'official-usdt-deposit-transfer-event-missing-or-mismatched' }
  }

  return {
    verified: true,
    asset: 'USDT',
    tokenContract: OFFICIAL_TRON_MAINNET_USDT,
    senderAddress: sponsorAddress,
    recipientAddress: vaultAddress,
    amountBaseUnits: requestedAmount,
    blockNumber: solidified.blockNumber,
    evidenceIndex: exactLogs[0].index,
    receiptResult: 'SUCCESS',
  }
}

/** Verify one exact solidified native TRX transfer from sponsor to Fireblocks vault. */
export function verifyThirdPartyTrxDepositEvidence(tronWeb, {
  transaction,
  transactionInfo,
  transactionHash,
  sponsorAddress,
  vaultAddress,
  maxTrxSun,
} = {}) {
  if (!tronWeb?.address?.toHex || !ADDRESS_PATTERN.test(sponsorAddress || '')
    || !ADDRESS_PATTERN.test(vaultAddress || '')
    || !validDigits(maxTrxSun, { positive: true })) {
    return { verified: false, reason: 'invalid-trx-deposit-verification-input' }
  }
  const solidified = solidifiedReceiptMatches(transaction, transactionInfo, transactionHash)
  if (!solidified.verified) return solidified

  const contracts = transaction?.raw_data?.contract
  if (!Array.isArray(contracts) || contracts.length !== 1 || contracts[0]?.type !== 'TransferContract') {
    return { verified: false, reason: 'unexpected-trx-deposit-operation' }
  }
  const expectedSponsor = normalizeAddressHex(tronWeb, sponsorAddress)
  const expectedVault = normalizeAddressHex(tronWeb, vaultAddress)
  const value = contracts[0]?.parameter?.value
  const amount = value?.amount
  const amountText = typeof amount === 'string' && /^[1-9][0-9]{0,77}$/.test(amount)
    ? amount
    : Number.isSafeInteger(amount) && amount > 0 ? String(amount) : ''
  if (!expectedSponsor || !expectedVault
    || normalizedHex(value?.owner_address) !== expectedSponsor
    || normalizedHex(value?.to_address) !== expectedVault
    || !validDigits(amountText, { positive: true })
    || BigInt(amountText) > BigInt(maxTrxSun)) {
    return { verified: false, reason: 'trx-deposit-source-recipient-or-amount-mismatch' }
  }
  return {
    verified: true,
    asset: 'TRX',
    tokenContract: null,
    senderAddress: sponsorAddress,
    recipientAddress: vaultAddress,
    amountBaseUnits: amountText,
    blockNumber: solidified.blockNumber,
    evidenceIndex: 0,
    receiptResult: 'SUCCESS',
  }
}

function inspectVerifiedFireblocksSnapshot(snapshot, expectedVaultAddress, nowMs) {
  if (!snapshot || snapshot.verificationStatus !== 'verified'
    || snapshot.repository !== 'MyTeleProject2026/trc20-usdt-token-cloner'
    || snapshot.branch !== 'main'
    || !/^[0-9a-f]{40}$/.test(snapshot.commitSha || '')
    || snapshot.configuration?.network !== 'mainnet'
    || snapshot.configuration?.signerMode !== 'fireblocks'
    || snapshot.configuration?.treasuryAddress !== expectedVaultAddress
    || snapshot.configuration?.usdtContract !== OFFICIAL_TRON_MAINNET_USDT
    || snapshot.configuration?.usdtDecimals !== 6
    || snapshot.configuration?.trxDecimals !== 6
    || typeof snapshot.configuration?.vaultAccountId !== 'string'
    || typeof snapshot.configuration?.usdtAssetId !== 'string'
    || typeof snapshot.configuration?.trxAssetId !== 'string'
    || snapshot.configuration?.apiKeyConfigured !== true) {
    return { verified: false, reason: 'verified-fireblocks-inventory-snapshot-required' }
  }
  const checkedAt = new Date(snapshot.checkedAt).getTime()
  if (!Number.isFinite(checkedAt) || checkedAt > nowMs + 60_000 || nowMs - checkedAt > MAX_INVENTORY_AGE_MS) {
    return { verified: false, reason: 'fireblocks-inventory-snapshot-stale-or-invalid' }
  }
  for (const name of REQUIRED_INVENTORY_CHECKS) {
    if (snapshot.checks?.[name] !== true) return { verified: false, reason: 'fireblocks-inventory-check-incomplete' }
  }
  const balanceNames = [
    'fireblocksUsdtAvailableBaseUnits', 'chainUsdtBalanceBaseUnits',
    'fireblocksTrxAvailableBaseUnits', 'chainTrxBalanceSun',
  ]
  for (const name of balanceNames) {
    if (!validDigits(snapshot.balances?.[name])) return { verified: false, reason: 'fireblocks-inventory-balance-unavailable' }
  }
  return { verified: true, checkedAt, snapshotId: String(snapshot.id) }
}

export function createThirdPartyFundingRouter({
  env = process.env,
  sessionLookup = getWalletAuthSession,
  readLatestSnapshot = getLatestFireblocksInventorySnapshot,
  verifyAuthorization = verifyThirdPartyFundingAuthorization,
  tronWebFactory = () => new TronWeb({
    fullHost: 'https://api.trongrid.io',
    ...(typeof env.TRONGRID_API_KEY === 'string' && env.TRONGRID_API_KEY.trim()
      ? { headers: { 'TRON-PRO-API-KEY': env.TRONGRID_API_KEY.trim() } } : {}),
  }),
  store = {
    persistAuthorization: persistThirdPartyFundingAuthorization,
    getAuthorization: getThirdPartyFundingAuthorization,
    listAuthorizations: listThirdPartyFundingAuthorizations,
    persistDeposit: persistThirdPartyFundingDeposit,
    markDepositFireblocksVerified: markThirdPartyFundingDepositFireblocksVerified,
    revokeAuthorization: revokeThirdPartyFundingAuthorization,
  },
  now = () => Date.now(),
} = {}) {
  const router = Router()

  async function authenticateOwner(req) {
    const ownerAddress = typeof env.OWNER_WALLET_ADDRESS === 'string' ? env.OWNER_WALLET_ADDRESS.trim() : ''
    const treasuryOwnerAddress = typeof env.TREASURY_OWNER_ADDRESS === 'string' ? env.TREASURY_OWNER_ADDRESS.trim() : ''
    if (!ADDRESS_PATTERN.test(ownerAddress) || !isValidTronAddress(ownerAddress)
      || ownerAddress !== treasuryOwnerAddress
      || !isValidTronAddress(treasuryOwnerAddress)) {
      return { ok: false, status: 503, error: 'treasury-owner-configuration-invalid' }
    }
    const authorization = header(req, 'authorization')
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization)
    const origin = header(req, 'origin')
    if (!match || !origin || origin.length > 512) {
      return { ok: false, status: 401, error: 'owner-session-required' }
    }
    let lookup
    try {
      lookup = await sessionLookup({ tokenHash: digest(match[1]), origin, nowMs: now() })
    } catch {
      lookup = null
    }
    if (lookup?.success !== true) return { ok: false, status: 503, error: 'owner-session-storage-unavailable' }
    const session = lookup.session
    if (!session || session.network !== 'mainnet' || session.origin !== origin) {
      return { ok: false, status: 401, error: 'owner-session-invalid-or-expired' }
    }
    if (session.address !== ownerAddress) return { ok: false, status: 403, error: 'owner-wallet-not-authorized' }
    return { ok: true, ownerAddress }
  }

  async function verifiedInventory(vaultAddress) {
    let result
    try { result = await readLatestSnapshot() } catch { result = null }
    if (result?.success !== true) return { verified: false, reason: 'fireblocks-inventory-status-unavailable' }
    return inspectVerifiedFireblocksSnapshot(result.snapshot, vaultAddress, now())
  }

  router.get('/third-party-funding/authorizations', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    res.setHeader('Pragma', 'no-cache')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const result = await store.listAuthorizations({ limit: 50 })
    if (result?.success !== true) return res.status(503).json({ success: false, error: result?.reason || 'authorization-storage-unavailable' })
    return res.json({ success: true, authorizations: result.authorizations })
  })

  router.post('/third-party-funding/authorizations', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    res.setHeader('Pragma', 'no-cache')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).some((key) => !['manifest', 'agreementReviewAcknowledged'].includes(key))
      || body.agreementReviewAcknowledged !== true
      || !body.manifest || typeof body.manifest !== 'object' || Array.isArray(body.manifest)) {
      return res.status(400).json({ success: false, error: 'written-agreement-review-acknowledgement-required' })
    }
    const vaultAddress = typeof env.TREASURY_ADDRESS === 'string' ? env.TREASURY_ADDRESS.trim() : ''
    if (!isValidTronAddress(vaultAddress) || env.TREASURY_SIGNER_MODE !== 'fireblocks') {
      return res.status(503).json({ success: false, error: 'configured-fireblocks-treasury-not-ready' })
    }
    const inventory = await verifiedInventory(vaultAddress)
    if (!inventory.verified) {
      return res.status(503).json({ success: false, error: inventory.reason, authorizationRegistered: false })
    }
    let verified
    try {
      verified = await verifyAuthorization(body.manifest, { expectedVaultAddress: vaultAddress, now })
    } catch {
      verified = { verified: false, reason: 'authorization-signature-verification-failed' }
    }
    if (verified?.verified !== true) {
      return res.status(400).json({ success: false, error: verified?.reason || 'authorization-not-verified' })
    }
    const manifest = body.manifest
    const message = buildThirdPartyFundingAuthorizationMessage(manifest)
    const signatureHash = digest(manifest.signature)
    const messageHash = digest(message)
    const persisted = await store.persistAuthorization({
      authorizationId: manifest.authorizationId,
      sponsorAddress: manifest.sponsorAddress,
      vaultAddress: manifest.vaultAddress,
      usdtContract: manifest.usdtContract,
      maxUsdtBaseUnits: manifest.maxUsdtBaseUnits,
      maxTrxSun: manifest.maxTrxSun,
      agreementReference: manifest.agreementReference,
      agreementReviewedBy: auth.ownerAddress,
      agreementReviewedAt: new Date(now()),
      signatureHash,
      messageHash,
      issuedAt: manifest.issuedAt,
      expiresAt: manifest.expiresAt,
    })
    if (persisted?.persisted !== true) {
      return res.status(409).json({ success: false, error: persisted?.reason || 'authorization-persistence-failed' })
    }
    return res.status(persisted.duplicate ? 200 : 201).json({
      success: true,
      duplicate: persisted.duplicate === true,
      authorizationId: manifest.authorizationId,
      status: persisted.status || 'awaiting-deposit',
      signerAddress: manifest.sponsorAddress,
      treasuryAddress: vaultAddress,
      agreementReference: manifest.agreementReference,
      authorizationScope: 'incoming-deposit-only',
      legalAuthorityIndependentlyVerified: false,
      payoutExecutionAuthorized: false,
      note: 'The source wallet signature and owner agreement-review acknowledgement were recorded. Corporate authority, source-of-funds due diligence and the actual legal agreement remain independently verified external requirements.',
    })
  })

  router.get('/third-party-funding/authorizations/:authorizationId', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    if (!AUTHORIZATION_ID_PATTERN.test(req.params.authorizationId || '')) {
      return res.status(400).json({ success: false, error: 'invalid-authorization-id' })
    }
    const result = await store.getAuthorization(req.params.authorizationId)
    if (result?.success !== true) return res.status(503).json({ success: false, error: result?.reason || 'authorization-storage-unavailable' })
    return res.json({ success: true, ...result })
  })

  router.post('/third-party-funding/authorizations/:authorizationId/deposits', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const authorizationId = req.params.authorizationId
    if (!AUTHORIZATION_ID_PATTERN.test(authorizationId || '')) {
      return res.status(400).json({ success: false, error: 'invalid-authorization-id' })
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).some((key) => !['asset', 'transactionHash'].includes(key))
      || !['USDT','TRX'].includes(body.asset)
      || typeof body.transactionHash !== 'string' || !TXID_PATTERN.test(body.transactionHash)) {
      return res.status(400).json({ success: false, error: 'invalid-deposit-reconciliation-request' })
    }
    const lookup = await store.getAuthorization(authorizationId)
    if (lookup?.success !== true || !lookup.authorization) {
      return res.status(404).json({ success: false, error: lookup?.reason || 'funding-authorization-not-found' })
    }
    const authorization = lookup.authorization
    if (authorization.status === 'revoked' || new Date(authorization.expiresAt).getTime() <= now()) {
      return res.status(409).json({ success: false, error: authorization.status === 'revoked' ? 'funding-authorization-revoked' : 'funding-authorization-expired' })
    }
    if (authorization.vaultAddress !== env.TREASURY_ADDRESS) {
      return res.status(409).json({ success: false, error: 'funding-authorization-vault-mismatch' })
    }

    let evidence
    try {
      const tronWeb = tronWebFactory()
      if (typeof tronWeb?.trx?.getConfirmedTransaction !== 'function'
        || typeof tronWeb?.trx?.getTransactionInfo !== 'function') {
        return res.status(503).json({ success: false, error: 'solidity-node-confirmed-transaction-api-unavailable' })
      }
      const [transaction, transactionInfo] = await Promise.all([
        tronWeb.trx.getConfirmedTransaction(body.transactionHash),
        tronWeb.trx.getTransactionInfo(body.transactionHash),
      ])
      const verifyInput = {
        transaction, transactionInfo, transactionHash: body.transactionHash,
        sponsorAddress: authorization.sponsorAddress, vaultAddress: authorization.vaultAddress,
      }
      evidence = body.asset === 'USDT'
        ? verifyThirdPartyUsdtDepositEvidence(tronWeb, {
            ...verifyInput, maxUsdtBaseUnits: authorization.maxUsdtBaseUnits,
          })
        : verifyThirdPartyTrxDepositEvidence(tronWeb, {
            ...verifyInput, maxTrxSun: authorization.maxTrxSun,
          })
    } catch {
      evidence = { verified: false, reason: 'solidified-tron-read-unavailable' }
    }
    if (evidence?.verified !== true) {
      const pending = ['solidified-transaction-or-receipt-not-found','transaction-not-in-solidified-block'].includes(evidence?.reason)
      return res.status(pending ? 202 : 409).json({
        success: false, status: pending ? 'awaiting-solidification' : 'verification-failed',
        error: evidence?.reason || 'deposit-not-verified',
        transactionHash: body.transactionHash.toLowerCase(),
      })
    }
    const persisted = await store.persistDeposit({
      authorizationId, transactionHash: body.transactionHash.toLowerCase(),
      asset: evidence.asset, tokenContract: evidence.tokenContract,
      senderAddress: evidence.senderAddress, recipientAddress: evidence.recipientAddress,
      amountBaseUnits: evidence.amountBaseUnits, blockNumber: evidence.blockNumber,
      evidenceIndex: evidence.evidenceIndex,
    })
    if (persisted?.persisted !== true) {
      return res.status(409).json({ success: false, error: persisted?.reason || 'deposit-evidence-persistence-failed' })
    }
    return res.status(persisted.duplicate ? 200 : 201).json({
      success: true, duplicate: persisted.duplicate === true,
      status: 'chain-confirmed-awaiting-fireblocks-inventory',
      authorizationId, transactionHash: body.transactionHash.toLowerCase(),
      asset: evidence.asset, tokenContract: evidence.tokenContract,
      senderAddress: evidence.senderAddress, recipientAddress: evidence.recipientAddress,
      amountBaseUnits: evidence.amountBaseUnits, blockNumber: evidence.blockNumber,
      fireblocksInventoryVerified: false, payoutExecutionAuthorized: false,
    })
  })

  router.post('/third-party-funding/authorizations/:authorizationId/deposits/fireblocks-reconcile', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const authorizationId = req.params.authorizationId
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (!AUTHORIZATION_ID_PATTERN.test(authorizationId || '')
      || Object.keys(body).some((key) => !['asset','transactionHash'].includes(key))
      || !['USDT','TRX'].includes(body.asset)
      || typeof body.transactionHash !== 'string' || !TXID_PATTERN.test(body.transactionHash)) {
      return res.status(400).json({ success: false, error: 'invalid-fireblocks-deposit-reconciliation-request' })
    }
    let inventoryResult
    try { inventoryResult = await readLatestSnapshot() } catch { inventoryResult = null }
    const vaultAddress = typeof env.TREASURY_ADDRESS === 'string' ? env.TREASURY_ADDRESS.trim() : ''
    const inventory = inventoryResult?.success === true
      ? inspectVerifiedFireblocksSnapshot(inventoryResult.snapshot, vaultAddress, now())
      : { verified: false, reason: 'fireblocks-inventory-status-unavailable' }
    if (!inventory.verified) return res.status(503).json({ success: false, error: inventory.reason, fireblocksInventoryVerified: false })

    const lookup = await store.getAuthorization(authorizationId)
    if (lookup?.success !== true) return res.status(503).json({ success: false, error: lookup?.reason || 'authorization-storage-unavailable' })
    const deposit = lookup?.deposits?.find((item) =>
      item.asset === body.asset && item.transactionHash.toLowerCase() === body.transactionHash.toLowerCase())
    if (!deposit || deposit.recipientAddress !== vaultAddress) {
      return res.status(404).json({ success: false, error: 'chain-confirmed-deposit-not-found' })
    }
    if (inventory.checkedAt < new Date(deposit.chainVerifiedAt).getTime()) {
      return res.status(409).json({ success: false, error: 'fireblocks-inventory-snapshot-predates-deposit' })
    }
    const providerBalance = body.asset === 'USDT'
      ? inventoryResult.snapshot.balances.fireblocksUsdtAvailableBaseUnits
      : inventoryResult.snapshot.balances.fireblocksTrxAvailableBaseUnits
    const chainBalance = body.asset === 'USDT'
      ? inventoryResult.snapshot.balances.chainUsdtBalanceBaseUnits
      : inventoryResult.snapshot.balances.chainTrxBalanceSun
    if (!validDigits(providerBalance) || !validDigits(chainBalance)
      || BigInt(providerBalance) < BigInt(deposit.amountBaseUnits)
      || BigInt(chainBalance) < BigInt(deposit.amountBaseUnits)) {
      return res.status(409).json({ success: false, error: 'fireblocks-vault-available-balance-does-not-cover-deposit' })
    }
    const result = await store.markDepositFireblocksVerified({
      authorizationId, asset: body.asset, transactionHash: body.transactionHash,
      snapshotId: inventory.snapshotId, treasuryAddress: vaultAddress,
      vaultAccountId: inventoryResult.snapshot.configuration.vaultAccountId,
      availableBalanceBaseUnits: providerBalance, chainBalanceBaseUnits: chainBalance,
      checkedAt: new Date(inventory.checkedAt),
    })
    if (result?.verified !== true) return res.status(409).json({ success: false, error: result?.reason || 'fireblocks-inventory-reconciliation-failed' })
    return res.json({
      success: true, duplicate: result.duplicate === true, status: 'fireblocks-inventory-verified',
      authorizationId, transactionHash: body.transactionHash.toLowerCase(), asset: body.asset,
      fireblocksSnapshotId: inventory.snapshotId, fireblocksCheckedAt: new Date(inventory.checkedAt).toISOString(),
      payoutExecutionAuthorized: false,
      note: 'The confirmed deposit is visible in the same configured Fireblocks vault asset inventory. This evidence does not authorize a payout.',
    })
  })

  router.post('/third-party-funding/authorizations/:authorizationId/revoke', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const authorizationId = req.params.authorizationId
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (!AUTHORIZATION_ID_PATTERN.test(authorizationId || '') || Object.keys(body).length > 0) {
      return res.status(400).json({ success: false, error: 'invalid-authorization-revocation-request' })
    }
    const result = await store.revokeAuthorization({ authorizationId, revokedBy: auth.ownerAddress })
    if (result?.revoked !== true) {
      const status = result?.reason === 'funding-authorization-not-found' ? 404 : 409
      return res.status(status).json({ success: false, error: result?.reason || 'authorization-revocation-failed' })
    }
    return res.json({
      success: true, duplicate: result.duplicate === true,
      authorizationId, status: 'revoked',
      revokedBy: auth.ownerAddress,
      payoutExecutionAuthorized: false,
    })
  })

  return router
}

export default createThirdPartyFundingRouter
