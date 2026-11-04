import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import pg from 'pg'
import { normalizeDatabaseConnectionString, databaseSslConfig, getWalletAuthSession } from '../database.mjs'
import { isValidTronAddress } from '../tron-address.mjs'

const { Pool } = pg
const SCHEMA = 'trc20_token_clone'
const MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const TXID_RE = /^[0-9a-f]{64}$/i
const NETWORKS = Object.freeze({
  mainnet: 'tron-mainnet',
  nile: 'tron-nile',
  shasta: 'tron-shasta',
})
const RPC_METHODS = new Set([
  'wallet/getaccount',
  'wallet/getaccountresource',
  'wallet/getaccountnet',
  'walletsolidity/getaccount',
  'walletsolidity/getaccountresource',
  'walletsolidity/getaccountnet',
  'wallet/triggerconstantcontract',
  'walletsolidity/triggerconstantcontract',
  'wallet/estimateenergy',
  'walletsolidity/estimateenergy',
  'wallet/getchainparameters',
  'walletsolidity/getchainparameters',
  'wallet/getnowblock',
  'walletsolidity/getnowblock',
  'wallet/gettransactionbyid',
  'walletsolidity/gettransactionbyid',
  'wallet/gettransactioninfobyid',
  'walletsolidity/gettransactioninfobyid',
  'wallet/getcontract',
  'walletsolidity/getcontract',
  'wallet/getblockbylatestnum',
  'walletsolidity/getblockbylatestnum',
  'wallet/validateaddress',
])

function cleanString(value, max = 256) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function parseUsdtAmount(value) {
  const raw = typeof value === 'string' ? value.trim() : String(value ?? '')
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(raw)) {
    throw new Error('Amount must be a positive USDT decimal with no more than 6 decimal places.')
  }
  const [whole, fraction = ''] = raw.split('.')
  const baseUnits = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0') || '0')
  if (baseUnits <= 0n || baseUnits > (1n << 256n) - 1n) throw new Error('Amount must be greater than zero and within the token limit.')
  return { baseUnits: baseUnits.toString(), decimal: (Number(baseUnits) / 1_000_000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') }
}

function configuredApiKey(env, network) {
  if (network === 'mainnet') return cleanString(env.TATUM_MAINNET_API_KEY || env.TATUM_API_KEY, 2048)
  return cleanString(env.TATUM_TESTNET_API_KEY || env.TATUM_API_KEY, 2048)
}

function apiBase(env) {
  const base = cleanString(env.TATUM_API_BASE || 'https://api.tatum.io', 256).replace(/\/+$/, '')
  if (base !== 'https://api.tatum.io') throw new Error('TATUM_API_BASE must use the approved Tatum API origin.')
  return base
}

async function tatumGatewayRequest({ env, network, path, body, timeoutMs = 12000 }) {
  const slug = NETWORKS[network]
  const key = configuredApiKey(env, network)
  if (!slug) throw Object.assign(new Error('Unsupported TRON network.'), { status: 400 })
  if (!key) throw Object.assign(new Error('Tatum API key is not configured for this network.'), { status: 503 })
  const response = await fetch(`https://${slug}.gateway.tatum.io/${path.replace(/^\/+/, '')}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify(body && typeof body === 'object' ? body : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw Object.assign(new Error('Tatum TRON RPC request failed.'), { status: response.status })
  return payload
}

async function tatumApiRequest({ env, network, path, query = {}, timeoutMs = 12000 }) {
  const key = configuredApiKey(env, network)
  if (!key) throw Object.assign(new Error('Tatum API key is not configured for this network.'), { status: 503 })
  const url = new URL(apiBase(env) + path)
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value))
  }
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'x-api-key': key },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw Object.assign(new Error('Tatum transaction-history request failed.'), { status: response.status })
  return payload
}

function normalizeHistoryRows(payload) {
  const rows = Array.isArray(payload) ? payload
    : Array.isArray(payload?.data) ? payload.data
      : Array.isArray(payload?.transactions) ? payload.transactions
        : Array.isArray(payload?.result) ? payload.result : []
  return rows.slice(0, 200).map((row) => {
    const txid = cleanString(row?.transaction_id || row?.txID || row?.txid || row?.transactionId || row?.hash, 96)
    const from = cleanString(row?.from || row?.fromAddress || row?.ownerAddress, 64)
    const to = cleanString(row?.to || row?.toAddress || row?.recipientAddress, 64)
    const token = row?.tokenInfo || row?.token_info || {}
    const contract = cleanString(row?.contractAddress || row?.contract_address || token?.address || token?.contractAddress, 64)
    const amount = cleanString(row?.value || row?.amount || row?.amountBaseUnits, 96)
    const decimalsValue = row?.tokenInfo?.decimals ?? row?.token_info?.decimals ?? row?.decimals
    const timestamp = Number(row?.block_timestamp || row?.timestamp || row?.blockTimestamp || 0)
    const blockNumber = Number(row?.block || row?.blockNumber || row?.block_number || 0)
    return {
      txid: TXID_RE.test(txid) ? txid.toLowerCase() : null,
      from: ADDRESS_RE.test(from) ? from : null,
      to: ADDRESS_RE.test(to) ? to : null,
      tokenContract: ADDRESS_RE.test(contract) ? contract : null,
      amountBaseUnits: /^(0|[1-9][0-9]*)$/.test(amount) ? amount : null,
      decimals: Number.isInteger(Number(decimalsValue)) && Number(decimalsValue) >= 0 && Number(decimalsValue) <= 36 ? Number(decimalsValue) : null,
      timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null,
      blockNumber: Number.isSafeInteger(blockNumber) && blockNumber > 0 ? blockNumber : null,
      confirmed: row?.confirmed === true || row?.confirmed === 'true' || row?.isConfirmed === true,
      direction: to ? 'incoming' : 'unknown',
    }
  }).filter((row) => row.txid)
}

function requestOrigin(req) {
  const origin = cleanString(req.headers?.origin, 512)
  try {
    const parsed = new URL(origin)
    if (parsed.origin !== origin || !['https:', 'http:'].includes(parsed.protocol)) return ''
    return origin
  } catch {
    return ''
  }
}

function allowedOrigins(env) {
  return [
    env.FRONTEND_ORIGIN,
    env.PACKAGED_APP_ORIGINS,
    env.OKX_UI_ORIGIN,
    env.TRON_TRANSFER_UI_ORIGIN,
  ].flatMap((value) => typeof value === 'string' ? value.split(',') : [])
    .map((value) => value.trim()).filter(Boolean)
}

async function requireOwnerSession(req, env) {
  const origin = requestOrigin(req)
  if (!origin || !allowedOrigins(env).includes(origin)) return { ok: false, status: 403, error: 'owner-origin-not-allowed' }
  const header = cleanString(req.headers?.authorization, 4096)
  const match = /^Bearer\s+([A-Za-z0-9_-]{32,256})$/i.exec(header)
  if (!match) return { ok: false, status: 401, error: 'owner-session-required' }
  const configuredOwner = cleanString(env.OWNER_LOGIN_ADDRESS || env.TREASURY_OWNER_ADDRESS || env.OWNER_WALLET_ADDRESS, 64)
  if (!configuredOwner || !isValidTronAddress(configuredOwner)) return { ok: false, status: 503, error: 'owner-login-not-configured' }
  const tokenHash = createHash('sha256').update(match[1]).digest('hex')
  const lookup = await getWalletAuthSession({ tokenHash, origin, nowMs: Date.now() })
  if (lookup?.success !== true) return { ok: false, status: 503, error: 'owner-session-storage-unavailable' }
  const session = lookup.session
  if (!session || session.network !== 'mainnet' || session.address !== configuredOwner || session.origin !== origin) {
    return { ok: false, status: 401, error: 'owner-session-invalid-or-expired' }
  }
  return { ok: true, address: configuredOwner }
}

function fincraConfig(env) {
  const mode = env.FINCRA_ENVIRONMENT === 'live' ? 'live' : 'sandbox'
  const baseUrl = mode === 'live' ? 'https://api.fincra.com' : 'https://sandboxapi.fincra.com'
  return {
    mode,
    baseUrl,
    apiKey: cleanString(env.FINCRA_SECRET_KEY, 4096),
    businessId: cleanString(env.FINCRA_BUSINESS_ID, 128),
    sourceCurrency: cleanString(env.FINCRA_SOURCE_CURRENCY || 'USDT', 8).toUpperCase(),
    payoutsEnabled: env.FINCRA_PAYOUTS_ENABLED === 'true',
    liveConfirmed: env.FINCRA_LIVE_STABLECOIN_PAYOUTS_CONFIRMED === 'true',
    webhookConfigured: Boolean(cleanString(env.FINCRA_WEBHOOK_SECRET, 4096)),
  }
}

async function fincraRequest(config, path, options = {}) {
  if (!config.apiKey) throw Object.assign(new Error('Fincra API credentials are not configured.'), { status: 503 })
  const response = await fetch(config.baseUrl + path, {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'api-key': config.apiKey,
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  })
  const payload = await response.json().catch(() => null)
  return { ok: response.ok, status: response.status, payload }
}

function responseRows(payload) {
  if (Array.isArray(payload?.data)) return payload.data
  if (Array.isArray(payload?.data?.wallets)) return payload.data.wallets
  if (Array.isArray(payload?.wallets)) return payload.wallets
  if (Array.isArray(payload?.result)) return payload.result
  return []
}

async function readFincraSourceBalance(config) {
  if (!config.apiKey || !config.businessId) return { checked: false, reason: 'fincra-not-configured' }
  const result = await fincraRequest(config, '/wallets?businessID=' + encodeURIComponent(config.businessId))
  if (!result.ok || result.payload?.success === false) return { checked: false, reason: 'fincra-wallets-unavailable', providerStatus: result.status }
  const wallet = responseRows(result.payload).find((item) => String(item?.currency || item?.sourceCurrency || '').toUpperCase() === config.sourceCurrency)
  if (!wallet) return { checked: false, reason: 'source-currency-wallet-not-found' }
  const availableRaw = wallet.availableBalance ?? wallet.available_balance ?? wallet.balance?.availableBalance
  const available = Number(availableRaw)
  if (!Number.isFinite(available) || available < 0) return { checked: false, reason: 'source-balance-not-readable' }
  return { checked: true, currency: config.sourceCurrency, availableBalance: String(availableRaw), walletId: cleanString(wallet.id || wallet.walletId, 128) || null }
}

function payoutStatusFromProvider(value) {
  const status = cleanString(value, 32).toLowerCase()
  if (status === 'successful') return 'successful'
  if (status === 'failed') return 'failed'
  if (status === 'processing') return 'processing'
  return 'unknown'
}

let pool
function getPool(env) {
  if (pool) return pool
  if (!cleanString(env.DATABASE_URL, 4096)) return null
  const connectionString = normalizeDatabaseConnectionString(env.DATABASE_URL)
  pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    max: 3,
    ssl: databaseSslConfig(connectionString, env),
  })
  pool.on('error', (error) => console.error('Tron Transfer database error:', error?.code || 'unknown'))
  return pool
}

export function createTronTransferRouter({ env = process.env, fetchImpl = fetch } = {}) {
  const router = Router()
  let schemaPromise = null

  async function ensureSchema(db) {
    if (!schemaPromise) {
      schemaPromise = (async () => {
        await db.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`)
        await db.query(`
          CREATE TABLE IF NOT EXISTS ${SCHEMA}.tron_transfer_sponsor_requests (
            id UUID PRIMARY KEY,
            customer_reference TEXT NOT NULL UNIQUE,
            requester_address TEXT NOT NULL,
            recipient_address TEXT NOT NULL,
            beneficiary_name TEXT NOT NULL,
            beneficiary_email TEXT,
            asset TEXT NOT NULL DEFAULT 'USDT' CHECK (asset = 'USDT'),
            network TEXT NOT NULL DEFAULT 'mainnet' CHECK (network = 'mainnet'),
            token_contract TEXT NOT NULL DEFAULT '${MAINNET_USDT}',
            amount_base_units NUMERIC(78,0) NOT NULL CHECK (amount_base_units > 0),
            amount_decimal NUMERIC(30,6) NOT NULL CHECK (amount_decimal > 0),
            status TEXT NOT NULL DEFAULT 'pending-organization-review',
            fincra_reference TEXT,
            fincra_status TEXT,
            fincra_webhook_event TEXT,
            fincra_webhook_received_at TIMESTAMPTZ,
            transaction_hash CHAR(64),
            chain_verification_status TEXT NOT NULL DEFAULT 'not-verified',
            chain_verification_reason TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `)
        await db.query(`CREATE INDEX IF NOT EXISTS tron_transfer_sponsor_requests_created_idx
          ON ${SCHEMA}.tron_transfer_sponsor_requests (created_at DESC)`)
      })().catch((error) => { schemaPromise = null; throw error })
    }
    await schemaPromise
  }

  function publicRequest(row) {
    return {
      id: row.id,
      customerReference: row.customer_reference,
      requesterAddress: row.requester_address,
      recipientAddress: row.recipient_address,
      beneficiaryName: row.beneficiary_name,
      beneficiaryEmail: row.beneficiary_email || null,
      asset: row.asset,
      network: row.network,
      tokenContract: row.token_contract,
      amountBaseUnits: String(row.amount_base_units),
      amount: String(row.amount_decimal),
      status: row.status,
      fincraReference: row.fincra_reference || null,
      fincraStatus: row.fincra_status || null,
      transactionHash: row.transaction_hash || null,
      chainVerificationStatus: row.chain_verification_status,
      chainVerificationReason: row.chain_verification_reason || null,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    }
  }

  async function findRequest(db, id) {
    const found = await db.query(
      `SELECT * FROM ${SCHEMA}.tron_transfer_sponsor_requests WHERE id = $1 LIMIT 1`,
      [id],
    )
    return found.rows[0] || null
  }

  router.get('/readiness', async (_req, res) => {
    const db = getPool(env)
    const fincra = fincraConfig(env)
    const mainnetConfigured = Boolean(configuredApiKey(env, 'mainnet'))
    const testnetConfigured = Boolean(configuredApiKey(env, 'nile'))
    let databaseReady = false
    if (db) {
      try { await ensureSchema(db); await db.query('SELECT 1'); databaseReady = true } catch {}
    }
    let sourceBalance = { checked: false, reason: 'fincra-not-configured' }
    if (fincra.apiKey && fincra.businessId) {
      try { sourceBalance = await readFincraSourceBalance(fincra) } catch { sourceBalance = { checked: false, reason: 'fincra-wallets-unavailable' } }
    }
    const canSandboxPayout = fincra.mode === 'sandbox' && fincra.payoutsEnabled && Boolean(fincra.apiKey && fincra.businessId && databaseReady)
    const canLivePayout = fincra.mode === 'live' && fincra.payoutsEnabled && fincra.liveConfirmed
      && Boolean(fincra.apiKey && fincra.businessId && fincra.webhookConfigured && databaseReady)
      && sourceBalance.checked && Number(sourceBalance.availableBalance) > 0
      && fincra.sourceCurrency === 'USDT'
    return res.json({
      success: true,
      status: 'readiness-evaluated',
      tatum: { mainnetConfigured, testnetConfigured, networkRouting: 'server-side-tatum-gateway', signedBroadcast: true },
      fincra: {
        environment: fincra.mode,
        apiKeyConfigured: Boolean(fincra.apiKey),
        businessIdConfigured: Boolean(fincra.businessId),
        webhookSecretConfigured: fincra.webhookConfigured,
        sourceCurrency: fincra.sourceCurrency,
        payoutsEnabled: fincra.payoutsEnabled,
        liveStablecoinPayoutsConfirmed: fincra.liveConfirmed,
        sourceBalance,
        canSubmitSandboxPayout: canSandboxPayout,
        canSubmitLivePayout: canLivePayout,
        requiredScheme: 'usdt_trc20',
      },
      storage: { configured: Boolean(env.DATABASE_URL), ready: databaseReady },
      mainnetUsdtContract: MAINNET_USDT,
      limitations: [
        'Tatum signs nothing: wallet transactions are signed locally and only signed raw transactions are submitted.',
        'A Fincra API acceptance is not settlement; query status or accept a verified webhook.',
        'A successful Fincra payout is not an independently verified TRON token transfer.',
        'Live payout requires a funded Fincra USDT source wallet and explicit live stablecoin enablement by Fincra.',
      ],
    })
  })

  router.all('/rpc/:network/*', async (req, res) => {
    const network = req.params.network
    const method = String(req.params[0] || '').replace(/^\/+/, '').toLowerCase()
    if (!Object.hasOwn(NETWORKS, network) || !RPC_METHODS.has(method) || req.method !== 'POST') {
      return res.status(404).json({ success: false, error: 'rpc-method-not-allowed' })
    }
    try {
      const payload = await tatumGatewayRequest({ env, network, path: method, body: req.body })
      return res.status(200).json(payload)
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 502
      return res.status(status >= 400 && status <= 599 ? status : 502).json({
        success: false,
        error: 'tatum-rpc-unavailable',
        providerStatus: Number.isInteger(error?.status) ? error.status : null,
      })
    }
  })

  router.post('/broadcast', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const network = cleanString(req.body?.network, 16)
    if (!['nile', 'shasta'].includes(network)) {
      return res.status(400).json({ success: false, error: 'testnet-broadcast-only', message: 'The new Tron Transfer signed-broadcast endpoint is currently limited to Nile and Shasta testnets.' })
    }
    const transaction = req.body?.transaction
    const txid = cleanString(transaction?.txID || transaction?.txid, 96)
    const rawHex = cleanString(transaction?.raw_data_hex, 200000)
    if (!TXID_RE.test(txid) || !/^(?:[0-9a-f]{2})+$/i.test(rawHex)
      || !Array.isArray(transaction?.signature) || transaction.signature.length < 1
      || transaction.signature.length > 5
      || !Array.isArray(transaction?.raw_data?.contract) || transaction.raw_data.contract.length !== 1) {
      return res.status(400).json({ success: false, error: 'invalid-signed-transaction', transactionSubmitted: false })
    }
    const computedId = createHash('sha256').update(Buffer.from(rawHex, 'hex')).digest('hex')
    if (computedId.toLowerCase() !== txid.toLowerCase()) {
      return res.status(409).json({ success: false, error: 'signed-transaction-id-mismatch', transactionSubmitted: false })
    }
    if (Number(transaction?.raw_data?.expiration) <= Date.now()) {
      return res.status(409).json({ success: false, error: 'signed-transaction-expired', transactionSubmitted: false })
    }
    try {
      const result = await tatumGatewayRequest({
        env, network, path: 'wallet/broadcasttransaction', body: transaction, timeoutMs: 20000,
      })
      if (result?.result !== true) {
        return res.status(409).json({
          success: false,
          error: 'tatum-broadcast-rejected',
          providerCode: cleanString(result?.code, 64) || null,
          transactionSubmitted: false,
          txid: txid.toLowerCase(),
        })
      }
      return res.status(202).json({
        success: true,
        status: 'broadcast-accepted',
        txid: txid.toLowerCase(),
        providerReportedTxid: cleanString(result?.txid || result?.txID, 96) || null,
        note: 'Tatum accepted the signed testnet transaction for broadcast. This is not confirmation; re-read the solidified transaction and receipt.',
      })
    } catch (error) {
      // The provider may have accepted the transaction before a network timeout.
      // The caller must reconcile this same txID; never create a replacement blindly.
      const status = Number.isInteger(error?.status) ? error.status : 502
      return res.status(202).json({
        success: false,
        status: 'broadcast-outcome-unknown',
        error: 'tatum-broadcast-outcome-unknown',
        providerStatus: status,
        txid: txid.toLowerCase(),
        note: 'The outcome is ambiguous. Check this exact transaction ID on the selected chain before building a replacement.',
      })
    }
  })

  router.get('/recipient', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const network = cleanString(req.query?.network, 16)
    const address = cleanString(req.query?.address, 64)
    const tokenContract = cleanString(req.query?.tokenContract, 64)
    if (!Object.hasOwn(NETWORKS, network) || !ADDRESS_RE.test(address) || !isValidTronAddress(address)
      || (tokenContract && (!ADDRESS_RE.test(tokenContract) || !isValidTronAddress(tokenContract)))) {
      return res.status(400).json({ success: false, error: 'invalid-recipient-query' })
    }
    try {
      const account = await tatumGatewayRequest({ env, network, path: 'walletsolidity/getaccount', body: { address, visible: true } })
      const nativeBalanceSun = /^(0|[1-9][0-9]*)$/.test(String(account?.balance ?? '0')) ? String(account?.balance ?? '0') : null
      const contract = tokenContract || (network === 'mainnet' ? MAINNET_USDT : '')
      let tokenBalance = null
      if (contract) {
        const tronWeb = await import('tronweb').then(module => module.TronWeb ? new module.TronWeb({ fullHost: `https://${NETWORKS[network]}.gateway.tatum.io` }) : new module.default({ fullHost: `https://${NETWORKS[network]}.gateway.tatum.io` }))
        const ownerHex = tronWeb.address.toHex(address)
        const contractHex = tronWeb.address.toHex(contract)
        const [balanceResult, decimalsResult] = await Promise.all([
          tatumGatewayRequest({ env, network, path: 'walletsolidity/triggerconstantcontract', body: {
            owner_address: ownerHex, contract_address: contractHex, function_selector: 'balanceOf(address)',
            parameter: ownerHex.replace(/^41/i, '').padStart(64, '0'), visible: false,
          } }),
          tatumGatewayRequest({ env, network, path: 'walletsolidity/triggerconstantcontract', body: {
            owner_address: ownerHex, contract_address: contractHex, function_selector: 'decimals()', parameter: '', visible: false,
          } }),
        ])
        const balanceHex = balanceResult?.constant_result?.[0]
        const decimalsHex = decimalsResult?.constant_result?.[0]
        const decimals = typeof decimalsHex === 'string' && /^[0-9a-f]+$/i.test(decimalsHex) ? Number(BigInt('0x' + decimalsHex)) : null
        const balanceBaseUnits = typeof balanceHex === 'string' && /^[0-9a-f]+$/i.test(balanceHex) ? BigInt('0x' + balanceHex).toString() : null
        if (balanceResult?.result?.result === true && balanceBaseUnits !== null && Number.isInteger(decimals) && decimals >= 0 && decimals <= 36) {
          tokenBalance = { contract, symbol: network === 'mainnet' && contract === MAINNET_USDT ? 'USDT' : 'TRC20', decimals, balanceBaseUnits }
        }
      }
      const [nativeHistory, tokenHistory] = await Promise.all([
        tatumApiRequest({ env, network, path: `/v3/tron/transaction/account/${encodeURIComponent(address)}`, query: { onlyTo: true, onlyConfirmed: true, orderBy: 'block_timestamp,desc' } }).catch(() => null),
        tatumApiRequest({ env, network, path: `/v3/tron/transaction/account/${encodeURIComponent(address)}/trc20`, query: { onlyTo: true, onlyConfirmed: true, orderBy: 'block_timestamp,desc', ...(contract ? { contractAddress: contract } : {}) } }).catch(() => null),
      ])
      const history = [
        ...normalizeHistoryRows(nativeHistory).map((row) => ({ ...row, asset: 'TRX', symbol: 'TRX', decimals: 6 })),
        ...normalizeHistoryRows(tokenHistory).map((row) => ({ ...row, asset: 'TRC20', symbol: tokenBalance?.symbol || 'TRC20', decimals: tokenBalance?.decimals ?? row.decimals })),
      ].filter((row) => row.to === address || row.to === null)
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 50)
      return res.json({
        success: true, network, address, nativeBalanceSun,
        nativeBalanceTRX: nativeBalanceSun === null ? null : (Number(nativeBalanceSun) / 1_000_000).toFixed(6),
        tokenBalance, incomingHistory: history,
        historyStatus: nativeHistory || tokenHistory ? 'tatum-history-read' : 'history-unavailable',
        checkedAt: new Date().toISOString(),
      })
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 502
      return res.status(status >= 400 && status <= 599 ? status : 502).json({
        success: false, error: 'recipient-inspection-unavailable',
        providerStatus: Number.isInteger(error?.status) ? error.status : null,
      })
    }
  })

  router.post('/sponsor-requests', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const requesterAddress = cleanString(req.body?.requesterAddress, 64)
    const recipientAddress = cleanString(req.body?.recipientAddress, 64)
    const beneficiaryName = cleanString(req.body?.beneficiaryName, 120)
    const beneficiaryEmail = cleanString(req.body?.beneficiaryEmail, 254)
    const customerReference = cleanString(req.body?.customerReference, 80)
    let amount
    try { amount = parseUsdtAmount(req.body?.amount) } catch (error) {
      return res.status(400).json({ success: false, error: 'invalid-amount', message: error.message })
    }
    if (!isValidTronAddress(requesterAddress) || !isValidTronAddress(recipientAddress)
      || !beneficiaryName || !/^[A-Za-z0-9._:-]{12,80}$/.test(customerReference)) {
      return res.status(400).json({ success: false, error: 'invalid-sponsor-request' })
    }
    if (beneficiaryEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(beneficiaryEmail)) {
      return res.status(400).json({ success: false, error: 'invalid-beneficiary-email' })
    }
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const id = randomUUID()
      const result = await db.query(`
        INSERT INTO ${SCHEMA}.tron_transfer_sponsor_requests
          (id,customer_reference,requester_address,recipient_address,beneficiary_name,beneficiary_email,amount_base_units,amount_decimal)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (customer_reference) DO NOTHING
        RETURNING *
      `, [id, customerReference, requesterAddress, recipientAddress, beneficiaryName, beneficiaryEmail || null, amount.baseUnits, amount.decimal])
      if (result.rows[0]) return res.status(201).json({ success: true, request: publicRequest(result.rows[0]), note: 'Request recorded for organization review. No payout was initiated.' })
      const existing = await db.query(`SELECT * FROM ${SCHEMA}.tron_transfer_sponsor_requests WHERE customer_reference=$1 LIMIT 1`, [customerReference])
      const prior = existing.rows[0]
      if (prior && prior.requester_address === requesterAddress && prior.recipient_address === recipientAddress
        && String(prior.amount_base_units) === amount.baseUnits) {
        return res.status(200).json({ success: true, duplicate: true, request: publicRequest(prior), note: 'Matching request already exists; no duplicate payout was submitted.' })
      }
      return res.status(409).json({ success: false, error: 'customer-reference-conflict' })
    } catch {
      return res.status(503).json({ success: false, error: 'sponsor-request-storage-unavailable' })
    }
  })

  router.get('/sponsor-requests', async (req, res) => {
    const auth = await requireOwnerSession(req, env)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const result = await db.query(`SELECT * FROM ${SCHEMA}.tron_transfer_sponsor_requests ORDER BY created_at DESC LIMIT 100`)
      return res.json({ success: true, requests: result.rows.map(publicRequest) })
    } catch {
      return res.status(503).json({ success: false, error: 'sponsor-request-list-unavailable' })
    }
  })

  async function fetchFincraPayoutByCustomerReference(config, customerReference) {
    const path = '/disbursements/payouts/customer-reference/' + encodeURIComponent(customerReference)
    return fincraRequest(config, path)
  }

  router.post('/sponsor-requests/:id/fincra-payout', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const auth = await requireOwnerSession(req, env)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    const config = fincraConfig(env)
    if (!config.payoutsEnabled || !config.apiKey || !config.businessId) {
      return res.status(503).json({ success: false, error: 'fincra-payout-not-configured', submissionEnabled: false })
    }
    if (config.sourceCurrency !== 'USDT') {
      return res.status(409).json({ success: false, error: 'fincra-source-currency-needs-quote-flow', message: 'The first release supports same-currency USDT funding only. Cross-currency payout requires a fresh Fincra quote and matching source amount.' })
    }
    if (config.mode === 'live' && !config.liveConfirmed) {
      return res.status(403).json({ success: false, error: 'live-stablecoin-payouts-not-confirmed', submissionEnabled: false })
    }
    try {
      await ensureSchema(db)
      const client = await db.connect()
      let row\n      let firstAttempt = false\n      try {
        await client.query('BEGIN')
        const found = await client.query(`SELECT * FROM ${SCHEMA}.tron_transfer_sponsor_requests WHERE id=$1 FOR UPDATE`, [req.params.id])
        if (!found.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'sponsor-request-not-found' }) }
        row = found.rows[0]
        if (['successful', 'failed'].includes(row.fincra_status)) {
          await client.query('COMMIT')
          return res.status(200).json({ success: true, duplicate: true, request: publicRequest(row), note: 'This payout already has a terminal Fincra status.' })
        }
        if (row.status === 'fincra-submitting' || row.status === 'fincra-outcome-unknown') {
          await client.query('COMMIT')
        } else if (row.status !== 'pending-organization-review') {
          await client.query('ROLLBACK')
          return res.status(409).json({ success: false, error: 'sponsor-request-not-submittable', status: row.status })
        } else {
          await client.query(`UPDATE ${SCHEMA}.tron_transfer_sponsor_requests
            SET status='fincra-submitting', updated_at=now() WHERE id=$1`, [row.id])
          await client.query('COMMIT')
          row.status = 'fincra-submitting'
        }
      } catch (error) {
        try { await client.query('ROLLBACK') } catch {}
        throw error
      } finally {
        client.release()
      }

      // A prior attempt may have reached Fincra even if our process timed out.
      // Always requery the exact customerReference before deciding to create anything.
      const prior = await fetchFincraPayoutByCustomerReference(config, row.customer_reference)
      if (prior.ok && prior.payload?.success !== false && prior.payload?.data) {
        const data = prior.payload.data
        const status = payoutStatusFromProvider(data.status)
        const updated = await db.query(`UPDATE ${SCHEMA}.tron_transfer_sponsor_requests
          SET status=$2,fincra_reference=$3,fincra_status=$4,updated_at=now() WHERE id=$1 RETURNING *`,
        [row.id, 'fincra-' + (status === 'unknown' ? 'processing' : status), cleanString(data.reference,128) || null, status])
        return res.status(200).json({ success: true, duplicate: true, request: publicRequest(updated.rows[0]), note: 'Existing Fincra payout was found by customer reference; no second payout was submitted.' })
      }
      if (prior.status !== 404) {
        await db.query(`UPDATE ${SCHEMA}.tron_transfer_sponsor_requests SET status='fincra-outcome-unknown',updated_at=now() WHERE id=$1`, [row.id])
        return res.status(202).json({ success: false, status: 'fincra-outcome-unknown', error: 'fincra-prior-request-check-unavailable', note: 'The prior request could not be disproved. No duplicate payout was submitted.' })
      }

      const balance = await readFincraSourceBalance(config)
      if (!balance.checked || Number(balance.availableBalance) < Number(row.amount_decimal)) {
        await db.query(`UPDATE ${SCHEMA}.tron_transfer_sponsor_requests SET status='pending-organization-review',updated_at=now() WHERE id=$1`, [row.id])
        return res.status(409).json({ success: false, error: 'fincra-source-balance-insufficient-or-unverified', sourceBalance: balance, note: 'Fincra must have sufficient available USDT to fund this principal. No payout was submitted.' })
      }

      // Reserve this request before the provider POST. After a timeout, only the
      // status-requery path may proceed; the payout call is never blindly retried.
      const body = {
        business: config.businessId,
        sourceCurrency: 'USDT',
        destinationCurrency: 'USDT',
        amount: Number(row.amount_decimal),
        description: 'Authorized USDT TRC20 sponsor payout',
        paymentDestination: 'crypto_wallet',
        paymentScheme: 'usdt_trc20',
        customerReference: row.customer_reference,
        beneficiary: {
          walletAddress: row.recipient_address,
          accountHolderName: row.beneficiary_name,
          ...(row.beneficiary_email ? { email: row.beneficiary_email } : {}),
        },
      }
      const created = await fincraRequest(config, '/disbursements/payouts', { method: 'POST', body })
      if (!created.ok || created.payload?.success !== true || !created.payload?.data) {
        const code = cleanString(created.payload?.errorType || created.payload?.error || 'fincra-payout-rejected', 96)
        await db.query(`UPDATE ${SCHEMA}.tron_transfer_sponsor_requests
          SET status='fincra-rejected',fincra_status='failed',chain_verification_status='not-verified',chain_verification_reason=$2,updated_at=now()
          WHERE id=$1`, [row.id, code])
        return res.status(400).json({ success: false, error: 'fincra-payout-rejected', providerStatus: created.status, providerCode: code, transactionSubmitted: false })
      }
      const data = created.payload.data
      const status = payoutStatusFromProvider(data.status)
      const updated = await db.query(`UPDATE ${SCHEMA}.tron_transfer_sponsor_requests
        SET status=$2,fincra_reference=$3,fincra_status=$4,updated_at=now() WHERE id=$1 RETURNING *`,
      [row.id, 'fincra-' + (status === 'unknown' ? 'processing' : status), cleanString(data.reference,128) || null, status])
      return res.status(202).json({
        success: true, request: publicRequest(updated.rows[0]),
        note: 'Fincra accepted the API request. Check provider status or a verified webhook; acceptance is not settlement or independent chain confirmation.',
      })
    } catch {
      return res.status(202).json({
        success: false, status: 'fincra-outcome-unknown', error: 'fincra-payout-outcome-unknown',
        note: 'Provider outcome may be ambiguous. Requery the original customer reference before any retry.',
      })
    }
  })

  router.post('/sponsor-requests/:id/fincra-status', async (req, res) => {
    const auth = await requireOwnerSession(req, env)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const db = getPool(env)
    const config = fincraConfig(env)
    if (!db || !config.apiKey) return res.status(503).json({ success: false, error: 'fincra-status-unavailable' })
    try {
      await ensureSchema(db)
      const row = await findRequest(db, req.params.id)
      if (!row) return res.status(404).json({ success: false, error: 'sponsor-request-not-found' })
      const result = await fetchFincraPayoutByCustomerReference(config, row.customer_reference)
      if (!result.ok || result.payload?.success === false || !result.payload?.data) {
        return res.status(result.status === 404 ? 404 : 502).json({ success: false, error: 'fincra-status-requery-unavailable', providerStatus: result.status })
      }
      const data = result.payload.data
      const status = payoutStatusFromProvider(data.status)
      const saved = await db.query(`UPDATE ${SCHEMA}.tron_transfer_sponsor_requests
        SET status=$2,fincra_reference=COALESCE($3,fincra_reference),fincra_status=$4,updated_at=now()
        WHERE id=$1 RETURNING *`,
      [row.id, 'fincra-' + (status === 'unknown' ? 'processing' : status), cleanString(data.reference,128) || null, status])
      return res.json({ success: true, request: publicRequest(saved.rows[0]) })
    } catch {
      return res.status(502).json({ success: false, error: 'fincra-status-requery-failed' })
    }
  })

  router.post('/fincra/webhook', async (req, res) => {
    const config = fincraConfig(env)
    const secret = cleanString(env.FINCRA_WEBHOOK_SECRET, 4096)
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
    const signature = cleanString(req.headers?.signature, 256).toLowerCase()
    if (!secret || !/^[0-9a-f]{128}$/.test(signature) || raw.length === 0) {
      return res.status(401).json({ success: false, error: 'invalid-fincra-webhook-signature' })
    }
    const expected = createHmac('sha512', secret).update(raw).digest()
    const supplied = Buffer.from(signature, 'hex')
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      return res.status(401).json({ success: false, error: 'invalid-fincra-webhook-signature' })
    }
    let payload
    try { payload = JSON.parse(raw.toString('utf8')) } catch { return res.status(400).json({ success: false, error: 'invalid-webhook-json' }) }
    const data = payload?.data || {}
    const customerReference = cleanString(data.customerReference || data.customer_reference, 80)
    const providerStatus = payoutStatusFromProvider(data.status || (payload?.event === 'payout.successful' ? 'successful' : payload?.event === 'payout.failed' ? 'failed' : 'processing'))
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const result = await db.query(`UPDATE ${SCHEMA}.tron_transfer_sponsor_requests
        SET status=$2,fincra_status=$3,fincra_reference=COALESCE($4,fincra_reference),
            fincra_webhook_event=$5,fincra_webhook_received_at=now(),updated_at=now()
        WHERE customer_reference=$1 RETURNING id`,
      [customerReference, 'fincra-' + (providerStatus === 'unknown' ? 'processing' : providerStatus), providerStatus,
        cleanString(data.reference,128) || null, cleanString(payload?.event,128) || null])
      return res.status(200).json({ success: true, matched: result.rowCount > 0 })
    } catch {
      return res.status(503).json({ success: false, error: 'webhook-persistence-unavailable' })
    }
  })

  router.post('/sponsor-requests/:id/verify-recipient-transfer', async (req, res) => {
    const auth = await requireOwnerSession(req, env)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const row = await findRequest(db, req.params.id)
      if (!row) return res.status(404).json({ success: false, error: 'sponsor-request-not-found' })
      if (row.fincra_status !== 'successful') {
        return res.status(409).json({ success: false, error: 'fincra-payout-not-successful', fincraStatus: row.fincra_status })
      }
      const history = await tatumApiRequest({
        env, network: 'mainnet',
        path: `/v3/tron/transaction/account/${encodeURIComponent(row.recipient_address)}/trc20`,
        query: { onlyTo: true, onlyConfirmed: true, orderBy: 'block_timestamp,desc', contractAddress: MAINNET_USDT },
      })
      const rows = normalizeHistoryRows(history).filter((item) => item.to === row.recipient_address
        && item.tokenContract === MAINNET_USDT && item.amountBaseUnits === String(row.amount_base_units)
        && item.timestamp && item.timestamp >= new Date(row.created_at).getTime() - 120000)
      if (rows.length === 1) {
        const saved = await db.query(`UPDATE ${SCHEMA}.tron_transfer_sponsor_requests
          SET transaction_hash=$2,chain_verification_status='recipient-transfer-match',chain_verification_reason='unique-confirmed-tatum-history-match',updated_at=now()
          WHERE id=$1 RETURNING *`, [row.id, rows[0].txid])
        return res.json({
          success: true, request: publicRequest(saved.rows[0]),
          verification: { status: 'unique-confirmed-recipient-history-match', txid: rows[0].txid, blockNumber: rows[0].blockNumber },
          note: 'The exact official USDT contract, recipient and amount matched one confirmed Tatum history entry after the request time. Compare the reference and transaction details with the Fincra receipt before treating this as final settlement evidence.',
        })
      }
      const reason = rows.length > 1 ? 'multiple-matching-incoming-transfers' : 'no-matching-confirmed-incoming-transfer'
      await db.query(`UPDATE ${SCHEMA}.tron_transfer_sponsor_requests
        SET chain_verification_status='not-verified',chain_verification_reason=$2,updated_at=now() WHERE id=$1`, [row.id, reason])
      return res.status(202).json({
        success: false, verification: { status: rows.length > 1 ? 'ambiguous' : 'not-found', reason, candidates: rows.length },
        note: 'Fincra status and TRON recipient transfer evidence are separate checks. No successful recipient credit is claimed.',
      })
    } catch {
      return res.status(502).json({ success: false, error: 'recipient-transfer-verification-unavailable' })
    }
  })

  return router
}

export default createTronTransferRouter
