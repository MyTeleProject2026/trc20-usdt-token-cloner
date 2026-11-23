import { createHash } from 'node:crypto'
import { TronWeb } from 'tronweb'
import pg from 'pg'
import { createOwnerOperationLedger } from './owner-operation-ledger.mjs'
import { createOwnerManagedSigner } from './owner-managed-signer.mjs'
import { normalizeMainnetAccountResources, normalizeMainnetPermissionSnapshot, estimateMainnetContractCallEnergy, calculateDeploymentResourceBudget, assertZeroTrxBurnBudget, assertTransactionIntegrity, verifyTransactionSigner, assertTransactionPermission } from '../src/tron-mainnet-preflight.mjs'
import { sponsorDatabaseConnectionString } from './sponsor-api.mjs'
import { normalizePostgresTlsMode } from './scripts/sponsor-ledger-database-identity.mjs'

const { Pool } = pg
const MAINNET = 'https://api.trongrid.io'
const CONFIRMATION_PHRASE = 'CONFIRM TRON MAINNET OWNER OPERATION'
const TXID = /^[0-9a-f]{64}$/i
const ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const UINT = /^(?:0|[1-9][0-9]{0,77})$/
const BYTES32 = /^(?:0x)?[0-9a-f]{64}$/i
const ABI = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'recipient', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'credit', stateMutability: 'nonpayable', inputs: [{ name: 'recipient', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'referenceId', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'batchCredit', stateMutability: 'nonpayable', inputs: [{ name: 'recipients', type: 'address[]' }, { name: 'amounts', type: 'uint256[]' }, { name: 'referenceIds', type: 'bytes32[]' }], outputs: [] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'setPaused', stateMutability: 'nonpayable', inputs: [{ name: 'value', type: 'bool' }], outputs: [] },
  { type: 'function', name: 'setMintingEnabled', stateMutability: 'nonpayable', inputs: [{ name: 'value', type: 'bool' }], outputs: [] },
  { type: 'function', name: 'transferOwnership', stateMutability: 'nonpayable', inputs: [{ name: 'nextOwner', type: 'address' }], outputs: [] },
  { type: 'function', name: 'acceptOwnership', stateMutability: 'nonpayable', inputs: [], outputs: [] },
]

const METHODS = Object.freeze({
  'owner-issue': { method: 'credit', args: input => [input.ownerAddress, uint(input.amount), bytes32(input.referenceId)] },
  credit: { method: 'credit', args: input => [address(input.recipient), uint(input.amount), bytes32(input.referenceId)] },
  'batch-credit': { method: 'batchCredit', args: input => {
    if (!Array.isArray(input.rows) || input.rows.length < 1 || input.rows.length > 50) fail('OWNER_BATCH_SIZE_INVALID')
    const recipients = input.rows.map(row => address(row?.recipient))
    const amounts = input.rows.map(row => uint(row?.amount))
    const references = input.rows.map(row => bytes32(row?.referenceId))
    if (new Set(references.map(value => value.toLowerCase())).size !== references.length) fail('OWNER_BATCH_REFERENCE_DUPLICATE')
    return [recipients, amounts, references]
  } },
  transfer: { method: 'transfer', args: input => [address(input.recipient), uint(input.amount)] },
  pause: { method: 'setPaused', args: () => [true] },
  unpause: { method: 'setPaused', args: () => [false] },
  'minting-enable': { method: 'setMintingEnabled', args: () => [true] },
  'minting-disable': { method: 'setMintingEnabled', args: () => [false] },
  'ownership-transfer': { method: 'transferOwnership', args: input => { const candidate = address(input.nextOwner); if (candidate === input.ownerAddress) fail('OWNER_OPERATION_NEXT_OWNER_MUST_DIFFER'); return [candidate] } },
})

function fail(code, status = 400) { throw Object.assign(new Error(code), { code, status }) }
function address(value) {
  if (typeof value !== 'string' || !ADDRESS.test(value)) fail('OWNER_OPERATION_ADDRESS_INVALID')
  return value
}
function uint(value) {
  const text = String(value ?? '')
  if (!UINT.test(text) || BigInt(text) <= 0n || BigInt(text) > (1n << 256n) - 1n) fail('OWNER_OPERATION_AMOUNT_INVALID')
  return text
}
function bytes32(value) {
  const text = String(value ?? '').replace(/^0x/i, '')
  if (!BYTES32.test(String(value ?? ''))) fail('OWNER_OPERATION_REFERENCE_INVALID')
  return '0x' + text.toLowerCase()
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  return JSON.stringify(value)
}
function operationIntentHash(operationType, intent) {
  return createHash('sha256').update(operationType + ':' + canonical(intent)).digest('hex')
}
function executionGateEnabled(env) {
  return env.OWNER_OPERATION_EXECUTION_ENABLED === 'true'
    && env.OWNER_OPERATION_MAINNET_ACK === 'CONFIRM_GUARDED_OWNER_EXECUTION'
    && env.OWNER_OPERATION_LEDGER_DURABLE === 'true'
    && env.OWNER_OPERATION_LEDGER_BACKUP_VERIFIED === 'true'
    && env.OWNER_OPERATION_LEDGER_RESTORE_TESTED === 'true'
}
function safeJson(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item))
}
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 16_384) fail('OWNER_OPERATION_REQUEST_TOO_LARGE', 413)
    chunks.push(chunk)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value
  } catch { fail('OWNER_OPERATION_INVALID_JSON') }
}
function normalizeIntent(input, ownerAddress) {
  const operationType = String(input?.operationType || '')
  const definition = Object.hasOwn(METHODS, operationType) ? METHODS[operationType] : null
  if (!definition) fail('OWNER_OPERATION_NOT_ALLOWLISTED')
  const args = definition.args({ ...input, ownerAddress })
  const feeLimitSun = String(input.feeLimitSun ?? '')
  if (!/^[1-9][0-9]{0,11}$/.test(feeLimitSun)) fail('OWNER_OPERATION_FEE_LIMIT_INVALID')
  const idempotencyKey = String(input.idempotencyKey || '')
  if (!/^[A-Za-z0-9._:-]{16,160}$/.test(idempotencyKey)) fail('OWNER_OPERATION_IDEMPOTENCY_KEY_INVALID')
  return { operationType, method: definition.method, args, feeLimitSun, idempotencyKey }
}
function createPacedFetch(fetchImpl, intervalMs = 350) {
  let queue = Promise.resolve()
  let nextAt = 0
  return (...args) => {
    const task = queue.then(async () => {
      const wait = Math.max(0, nextAt - Date.now())
      if (wait) await new Promise(resolve => setTimeout(resolve, wait))
      let response = await fetchImpl(...args)
      if (response.status === 429) {
        const retryAfter = Number(response.headers?.get?.('retry-after'))
        const retryMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(5000, retryAfter * 1000) : 1000
        await new Promise(resolve => setTimeout(resolve, retryMs))
        response = await fetchImpl(...args)
      }
      nextAt = Date.now() + intervalMs
      return response
    })
    queue = task.catch(() => {})
    return task
  }
}

function rpcHeaders(env) {
  return { accept: 'application/json', 'content-type': 'application/json',
    ...(typeof env.TRONGRID_API_KEY === 'string' && env.TRONGRID_API_KEY.trim()
      ? { 'TRON-PRO-API-KEY': env.TRONGRID_API_KEY.trim() } : {}) }
}
async function rpcPost(path, payload, { fetchImpl, env }) {
  const response = await fetchImpl(MAINNET + path, {
    method: 'POST', headers: rpcHeaders(env), body: JSON.stringify(payload),
    redirect: 'error', signal: AbortSignal.timeout(8_000),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw Object.assign(new Error('TRON Mainnet node returned HTTP ' + response.status + ' for ' + path), { code: 'OWNER_MAINNET_RPC_UNAVAILABLE', status: 503, upstreamStatus: response.status })
  if (result?.Error || result?.error) throw Object.assign(new Error(String(result?.Error || result?.error).slice(0, 160)), { code: 'OWNER_MAINNET_RPC_UNAVAILABLE', status: 503 })
  return result
}
function asAddress(tronWeb, value) {
  try { return value && (String(value).startsWith('T') ? value : tronWeb.address.fromHex(value)) } catch { return '' }
}
async function verifyContract(tronWeb, contractAddress, ownerAddress, { fetchImpl, env }) {
  const expectedRuntimeHash = String(env.TRAX_RUNTIME_BYTECODE_SHA256 || '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(expectedRuntimeHash)) fail('OWNER_TRAX_RUNTIME_HASH_NOT_CONFIGURED', 503)
  const info = await rpcPost('/wallet/getcontractinfo', { value: contractAddress, visible: true }, { fetchImpl, env })
  const runtimeCode = String(info?.runtimecode || '').replace(/^0x/i, '').toLowerCase()
  if (!/^(?:[0-9a-f]{2})+$/i.test(runtimeCode)
    || createHash('sha256').update(Buffer.from(runtimeCode, 'hex')).digest('hex') !== expectedRuntimeHash) {
    fail('OWNER_TRAX_RUNTIME_BYTECODE_MISMATCH', 409)
  }
  const contract = await tronWeb.contract(ABI).at(contractAddress)
  const name = await contract.name().call()
  await new Promise(resolve => setTimeout(resolve, 350))
  const symbol = await contract.symbol().call()
  await new Promise(resolve => setTimeout(resolve, 350))
  const decimals = await contract.decimals().call()
  await new Promise(resolve => setTimeout(resolve, 350))
  const owner = await contract.owner().call()
  if (String(name) !== 'TRӾ' || String(symbol) !== 'TRӾ' || Number(decimals) !== 6) fail('OWNER_TRAX_CONTRACT_METADATA_MISMATCH', 409)
  if (asAddress(tronWeb, owner) !== ownerAddress) fail('OWNER_NOT_CURRENT_ONCHAIN_CONTRACT_OWNER', 403)
  return { name: String(name), symbol: String(symbol), decimals: Number(decimals), owner: ownerAddress }
}
async function buildUnsigned(tronWeb, contractAddress, ownerAddress, normalized) {
  if (!tronWeb.isAddress(ownerAddress) || !tronWeb.isAddress(contractAddress)) fail('OWNER_OPERATION_MAINNET_ADDRESS_INVALID')
  const abi = ABI.find(item => item.type === 'function' && item.name === normalized.method)
  if (!abi) fail('OWNER_OPERATION_ABI_METHOD_MISSING', 500)
  const signature = normalized.method + '(' + abi.inputs.map(item => item.type).join(',') + ')'
  abi.inputs.forEach((input, index) => {
    if (input.type === 'address' && !tronWeb.isAddress(normalized.args[index])) fail('OWNER_OPERATION_ADDRESS_INVALID')
    if (input.type === 'address[]' && (!Array.isArray(normalized.args[index]) || normalized.args[index].some(value => !tronWeb.isAddress(value)))) fail('OWNER_OPERATION_BATCH_ADDRESS_INVALID')
  })
  const built = await tronWeb.transactionBuilder.triggerSmartContract(
    contractAddress,
    signature,
    { feeLimit: Number(normalized.feeLimitSun), callValue: 0, from: ownerAddress, funcABIV2: abi, parametersV2: normalized.args },
    [],
    tronWeb.address.toHex(ownerAddress),
  )
  const transaction = built?.transaction || built
  if (built?.result?.result !== true || Number(transaction?.raw_data?.fee_limit) !== Number(normalized.feeLimitSun)
    || !TXID.test(String(transaction?.txID || ''))
    || !/^(?:[0-9a-f]{2})+$/i.test(String(transaction?.raw_data_hex || ''))
    || transaction?.raw_data?.contract?.length !== 1
    || transaction.raw_data.contract[0]?.type !== 'TriggerSmartContract') fail('OWNER_UNSIGNED_TRANSACTION_BUILD_FAILED', 503)
  const rawHash = createHash('sha256').update(Buffer.from(transaction.raw_data_hex, 'hex')).digest('hex')
  const value = transaction.raw_data.contract[0]?.parameter?.value || {}
  if (rawHash.toLowerCase() !== String(transaction.txID).toLowerCase()) fail('OWNER_UNSIGNED_TRANSACTION_ID_MISMATCH', 409)
  if (Number(transaction.raw_data?.contract?.[0]?.Permission_id ?? transaction.raw_data?.contract?.[0]?.permission_id ?? 0) !== 0
    || asAddress(tronWeb, value.owner_address) !== ownerAddress
    || asAddress(tronWeb, value.contract_address) !== contractAddress
    || Number(value.call_value || 0) !== 0
    || !String(value.data || '').toLowerCase().startsWith(String(tronWeb.sha3(signature)).replace(/^0x/i, '').slice(0, 8).toLowerCase())) {
    fail('OWNER_UNSIGNED_TRANSACTION_INTENT_MISMATCH', 409)
  }
  return safeJson(transaction)
}
async function preflight(tronWeb, transaction, ownerAddress, contractAddress, { fetchImpl, env }) {
  const value = transaction?.raw_data?.contract?.[0]?.parameter?.value
  const data = String(value?.data || '').replace(/^0x/i, '')
  if (!/^(?:[0-9a-f]{2}){4,}$/i.test(data)) fail('OWNER_OPERATION_CALL_DATA_INVALID', 409)
  const resourceResponse = await rpcPost('/wallet/getaccountresource', { address: ownerAddress, visible: true }, { fetchImpl, env })
  const account = await rpcPost('/wallet/getaccount', { address: ownerAddress, visible: true }, { fetchImpl, env })
  const chainParameters = await rpcPost('/wallet/getchainparameters', {}, { fetchImpl, env })
  const resourceSnapshot = normalizeMainnetAccountResources(resourceResponse, chainParameters)
  if (asAddress(tronWeb, account?.address) !== ownerAddress) fail('OWNER_MAINNET_ACCOUNT_ADDRESS_MISMATCH', 409)
  const permission = normalizeMainnetPermissionSnapshot(account, ownerAddress, tronWeb)
  if (Number(permission.permissionId) !== 0) fail('OWNER_OPERATION_PERMISSION_ID_NOT_OWNER', 403)
  if (!permission.connectedSignerCanAuthorizeAlone) fail('OWNER_SIGNER_CANNOT_SATISFY_OWNER_PERMISSION', 403)
  const estimate = await estimateMainnetContractCallEnergy(
    tronWeb, contractAddress, data, ownerAddress,
    (_client, path, body) => rpcPost(path, body, { fetchImpl, env }),
  )
  let budget
  try {
    budget = calculateDeploymentResourceBudget({
      energyRequired: estimate.energyUsed,
      resourceSnapshot,
      rawDataHex: transaction.raw_data_hex,
      feeLimitSun: String(transaction.raw_data.fee_limit),
      safetyMarginBps: 12500,
      transactionLabel: 'TRӾ owner operation',
    })
  } catch (error) {
    const message = String(error?.message || '')
    if (/ZERO-TRX-BURN PROTECTION BLOCKED/i.test(message)) fail('OWNER_ZERO_TRX_BURN_PREFLIGHT_BLOCKED', 423)
    if (/fee cap|fee_limit|fee limit/i.test(message)) fail('OWNER_OPERATION_FEE_LIMIT_UNSAFE', 422)
    throw error
  }
  const txId = String(transaction.txID || '').toLowerCase()
  if (!TXID.test(txId)) fail('OWNER_UNSIGNED_TRANSACTION_ID_INVALID', 500)
  try { assertZeroTrxBurnBudget(budget) }
  catch { fail('OWNER_ZERO_TRX_BURN_PREFLIGHT_BLOCKED', 423) }
  return {
    network: 'TRON Mainnet', ownerAddress, contractAddress, permission,
    estimatedEnergy: estimate.energyUsed,
    energyPenalty: estimate.energyPenalty,
    requiredEnergyWithSafetyMargin: budget.energyWithSafetyMargin,
    availableEnergy: budget.availableEnergy,
    transactionBytes: budget.estimatedBandwidthBytes,
    availableBandwidth: budget.availableBandwidth,
    estimatedTrxFallbackSun: budget.requiredTrxSun,
    energyBurnSun: budget.energyBurnSun,
    bandwidthBurnSun: budget.bandwidthBurnSun,
    feeLimitSun: budget.feeLimitSun,
    maxFeeLimitSun: resourceSnapshot.maxFeeLimitSun,
    accountBalanceSun: String(account.balance ?? '0'),
    txID: txId, checkedAt: new Date().toISOString(),
  }
}

export function createOwnerOperationApi({
  env = process.env, send, authenticateManagedSession, database = null,
  fetchImpl = fetch, tronWebFactory = options => new TronWeb(options),
  prepareTransaction = buildUnsigned, preflightTransaction = preflight,
  verifyContractState = verifyContract,
  signerFactory = options => createOwnerManagedSigner(options),
  verifyUnsignedTransaction = (tronWeb, unsigned) => assertTransactionIntegrity(tronWeb, unsigned, 'Unsigned TRӾ Owner operation'),
  verifySignedTransaction = async (tronWeb, signed, ownerAddress) => {
    assertTransactionIntegrity(tronWeb, signed, 'Signed TRӾ Owner operation')
    verifyTransactionSigner(tronWeb, signed, ownerAddress)
    await assertTransactionPermission(tronWeb, signed, ownerAddress)
  },
  broadcastTransaction = (tronWeb, signed) => tronWeb.trx.sendRawTransaction(signed),
  reconcileTransaction = async (txId, ownerAddress, contractAddress, { fetchImpl: requestFetch, env: requestEnv, tronWeb }) => {
    const info = await rpcPost('/walletsolidity/gettransactioninfobyid', { value: txId }, { fetchImpl: requestFetch, env: requestEnv })
    const transaction = await rpcPost('/walletsolidity/gettransactionbyid', { value: txId }, { fetchImpl: requestFetch, env: requestEnv })
    const confirmedId = String(info?.id || info?.txID || transaction?.txID || '').toLowerCase()
    if (confirmedId && confirmedId !== txId.toLowerCase()) fail('OWNER_SOLIDIFIED_RECEIPT_TXID_MISMATCH', 409)
    const blockNumber = Number(info?.blockNumber)
    const contracts = transaction?.raw_data?.contract
    if (!Array.isArray(contracts) || contracts.length !== 1 || contracts[0]?.type !== 'TriggerSmartContract') {
      return { solidified: false, status: 'transaction-not-found-or-invalid' }
    }
    const value = contracts[0]?.parameter?.value || {}
    if (asAddress(tronWeb, value.owner_address) !== ownerAddress) fail('OWNER_SOLIDIFIED_RECEIPT_OWNER_MISMATCH', 409)
    if (asAddress(tronWeb, value.contract_address) !== contractAddress) fail('OWNER_SOLIDIFIED_RECEIPT_CONTRACT_MISMATCH', 409)
    assertTransactionIntegrity(tronWeb, transaction, 'Solidified TRON Mainnet transaction')
    verifyTransactionSigner(tronWeb, transaction, ownerAddress)
    if (!Number.isSafeInteger(blockNumber) || blockNumber <= 0) return { solidified: false, status: 'not-solidified' }
    const result = String(info?.receipt?.result || info?.result || '').toUpperCase()
    if (!result) return { solidified: false, status: 'solidified-receipt-result-unavailable', blockNumber }
    return { solidified: true, success: result === 'SUCCESS', status: result, blockNumber }
  },
  ledgerFactory = options => createOwnerOperationLedger(options),
} = {}) {
  if (typeof send !== 'function' || typeof authenticateManagedSession !== 'function') throw new TypeError('Owner operation API dependencies are required')
  const pacedFetch = createPacedFetch(fetchImpl)
  let pool = database
  async function getDatabase() {
    if (typeof pool === 'function') return await pool()
    if (pool) return pool
    const connection = sponsorDatabaseConnectionString(env)
    if (!connection) return null
    pool = new Pool({ connectionString: normalizePostgresTlsMode(connection), connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000, max: 3 })
    pool.on('error', error => process.stderr.write('Owner operation ledger database error: ' + String(error?.code || 'unknown') + '\n'))
    return pool
  }
  const reply = (res, status, payload, origin) => { send(res, status, payload, origin); return true }
  const rateBuckets = new Map()
  function consumeRateLimit(sessionId, action) {
    const limits = { prepare: 6, confirm: 3, cancel: 6, read: 30 }
    const limit = limits[action] || 10
    const now = Date.now()
    const key = String(sessionId) + ':' + action
    let bucket = rateBuckets.get(key)
    if (!bucket || now - bucket.startedAt >= 60_000) {
      bucket = { startedAt: now, count: 0 }
      rateBuckets.set(key, bucket)
    }
    if (bucket.count >= limit) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((60_000 - (now - bucket.startedAt)) / 1000)) }
    bucket.count += 1
    if (rateBuckets.size > 5000) {
      for (const [bucketKey, value] of rateBuckets) if (now - value.startedAt >= 60_000) rateBuckets.delete(bucketKey)
    }
    return { allowed: true }
  }

  async function handle(req, res, url, origin) {
    const path = url.pathname
    const route = path.match(/^\/api\/owner\/operations\/([0-9a-f-]{36})(?:\/(confirm|cancel))?$/i)
    const operationId = route?.[1] || ''
    const action = route?.[2] || ''
    const listRoute = path === '/api/owner/operations'
    if (path !== '/api/owner/operations/prepare' && !route && !listRoute) return false
    const session = await authenticateManagedSession(req, { requireCsrf: req.method !== 'GET' })
    if (!session || session.address !== env.TRON_OWNER_ADDRESS) {
      return reply(res, 401, { success: false, error: 'OWNER_SESSION_REQUIRED' }, origin)
    }
    const rateAction = req.method === 'POST'
      ? (path === '/api/owner/operations/prepare' ? 'prepare' : action || 'write')
      : 'read'
    const rate = consumeRateLimit(session.sessionId, rateAction)
    if (!rate.allowed) return reply(res, 429, { success: false, error: 'OWNER_OPERATION_RATE_LIMITED', retryAfterSeconds: rate.retryAfterSeconds }, origin)
    const db = await getDatabase()
    if (!db) return reply(res, 503, { success: false, error: 'OWNER_OPERATION_LEDGER_UNAVAILABLE' }, origin)
    if (env.OWNER_OPERATION_LEDGER_DURABLE !== 'true'
      || env.OWNER_OPERATION_LEDGER_BACKUP_VERIFIED !== 'true'
      || env.OWNER_OPERATION_LEDGER_RESTORE_TESTED !== 'true') {
      return reply(res, 503, { success: false, error: 'OWNER_OPERATION_LEDGER_DURABILITY_NOT_VERIFIED' }, origin)
    }

    try {
      const schema = await db.query("SELECT to_regclass('public.tron_transfer_owner_operations') AS operations_table")
      if (!schema.rows?.[0]?.operations_table) {
        return reply(res, 503, { success: false, error: 'OWNER_OPERATION_LEDGER_SCHEMA_NOT_INITIALIZED' }, origin)
      }
      const ledger = ledgerFactory({ database: db })

      if (req.method === 'GET' && listRoute) {
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') || 20)))
        const rows = await ledger.list(session.sessionId, limit)
        return reply(res, 200, {
          success: true, network: 'TRON Mainnet', executionEnabled: executionGateEnabled(env),
          operations: rows.map(row => ({
            operationId: row.operation_id, operationType: row.operation_type,
            contractAddress: row.contract_address, state: row.state,
            intentSha256: String(row.intent_sha256 || '').trim(),
            method: row.intent?.method || null, args: row.intent?.args || null,
            feeLimitSun: row.intent?.feeLimitSun || null,
            transactionId: row.transaction_id || null, blockNumber: row.block_number || null,
            failureCode: row.failure_code || null, preflight: row.preflight || null,
            createdAt: row.created_at, updatedAt: row.updated_at,
          })),
        }, origin)
      }

      if (req.method === 'POST' && path === '/api/owner/operations/prepare') {
        const input = await readBody(req)
        const ownerAddress = String(env.TRON_OWNER_ADDRESS || '')
        const contractAddress = String(env.TRAX_CONTRACT_ADDRESS || '')
        if (!ADDRESS.test(ownerAddress) || !ADDRESS.test(contractAddress)) {
          return reply(res, 503, { success: false, error: 'OWNER_MAINNET_IDENTITY_OR_TRAX_CONTRACT_NOT_CONFIGURED' }, origin)
        }
        if (String(input.contractAddress || '') !== contractAddress) fail('OWNER_OPERATION_CONTRACT_ADDRESS_MISMATCH', 409)
        const normalized = normalizeIntent(input, ownerAddress)
        const signer = signerFactory({ env })
        if (signer.address !== ownerAddress || signer.network !== 'TRON Mainnet') fail('OWNER_MANAGED_SIGNER_IDENTITY_MISMATCH', 403)
        const maxFee = BigInt(String(env.OWNER_MAX_FEE_LIMIT_SUN || '150000000'))
        if (BigInt(normalized.feeLimitSun) > maxFee) fail('OWNER_OPERATION_FEE_LIMIT_EXCEEDS_SERVER_CAP')
        const intent = { method: normalized.method, args: normalized.args, feeLimitSun: normalized.feeLimitSun }
        const record = await ledger.prepare({
          sessionId: session.sessionId, idempotencyKey: normalized.idempotencyKey,
          operationType: normalized.operationType, contractAddress, intent,
        })
        if (record.replay) {
          return reply(res, 200, {
            success: true, replay: true, operationId: record.operation_id, state: record.state,
            intentSha256: String(record.intent_sha256 || '').trim(),
            transactionId: record.transaction_id || null, retryAllowed: false,
            executionEnabled: executionGateEnabled(env),
            note: 'This idempotency key already identifies the same durable Owner intent. It was not rebuilt or resubmitted.',
          }, origin)
        }
        let transaction
        let result
        try {
          const tronWeb = tronWebFactory({ fullHost: MAINNET, headers: rpcHeaders(env) })
          await verifyContractState(tronWeb, contractAddress, ownerAddress, { fetchImpl: pacedFetch, env })
          transaction = await prepareTransaction(tronWeb, contractAddress, ownerAddress, normalized)
          result = await preflightTransaction(tronWeb, transaction, ownerAddress, contractAddress, { fetchImpl: pacedFetch, env })
        } catch (error) {
          await ledger.transition({
            operationId: record.operation_id, sessionId: session.sessionId,
            nextState: 'failed', failureCode: String(error?.code || error?.message || 'OWNER_PREFLIGHT_FAILED').slice(0, 100),
          }).catch(() => {})
          throw error
        }
        await ledger.transition({
          operationId: record.operation_id, sessionId: session.sessionId,
          nextState: 'preflight-passed', receipt: { unsignedTransaction: transaction, preflight: result },
        })
        await ledger.transition({ operationId: record.operation_id, sessionId: session.sessionId, nextState: 'awaiting-confirmation' })
        return reply(res, 201, {
          success: true, replay: false, operationId: record.operation_id, state: 'awaiting-confirmation',
          operationType: normalized.operationType, method: normalized.method, args: normalized.args,
          ownerAddress, contractAddress, preflight: result, confirmationPhrase: CONFIRMATION_PHRASE,
          intentSha256: String(record.intent_sha256 || '').trim(),
          transactionExpiresAt: transaction.raw_data?.expiration || null,
          signerConfigured: true, executionEnabled: executionGateEnabled(env),
          note: executionGateEnabled(env)
            ? 'Review the exact intent and submit a separate confirmation to sign and broadcast.'
            : 'Prepared for review only. Signing and broadcasting remain disabled until the execution and verified-ledger gates are enabled.',
        }, origin)
      }

      if (req.method === 'POST' && route && action === 'cancel') {
        const operation = await ledger.get(operationId, session.sessionId)
        if (!operation) return reply(res, 404, { success: false, error: 'OWNER_OPERATION_NOT_FOUND' }, origin)
        const cancelled = await ledger.transition({ operationId, sessionId: session.sessionId, nextState: 'cancelled' })
        return reply(res, 200, { success: true, operationId, state: cancelled.state, retryAllowed: false }, origin)
      }

      if (req.method === 'POST' && route && action === 'confirm') {
        if (!executionGateEnabled(env)) {
          return reply(res, 423, { success: false, error: 'OWNER_OPERATION_EXECUTION_GATES_DISABLED', executionEnabled: false, retryAllowed: false }, origin)
        }
        const input = await readBody(req)
        const operation = await ledger.get(operationId, session.sessionId)
        if (!operation) return reply(res, 404, { success: false, error: 'OWNER_OPERATION_NOT_FOUND' }, origin)
        if (operation.state !== 'awaiting-confirmation') {
          return reply(res, 409, { success: false, error: 'OWNER_OPERATION_NOT_AWAITING_CONFIRMATION', state: operation.state, retryAllowed: false }, origin)
        }
        const intentHash = String(operation.intent_sha256 || '').trim().toLowerCase()
        if (input.confirmationPhrase !== CONFIRMATION_PHRASE || String(input.intentSha256 || '').toLowerCase() !== intentHash) {
          return reply(res, 400, { success: false, error: 'OWNER_OPERATION_EXPLICIT_CONFIRMATION_MISMATCH', retryAllowed: false }, origin)
        }
        if (operationIntentHash(operation.operation_type, operation.intent) !== intentHash) {
          return reply(res, 409, { success: false, error: 'OWNER_OPERATION_LEDGER_INTENT_INTEGRITY_FAILED', retryAllowed: false }, origin)
        }
        if (operation.contract_address !== env.TRAX_CONTRACT_ADDRESS
          || operation.contract_address !== String(input.contractAddress || '')) {
          return reply(res, 409, { success: false, error: 'OWNER_OPERATION_CONTRACT_ADDRESS_MISMATCH', retryAllowed: false }, origin)
        }
        let claimed
        try { claimed = await ledger.claimConfirmation(operationId, session.sessionId) }
        catch {
          return reply(res, 409, { success: false, error: 'OWNER_OPERATION_CONFIRMATION_ALREADY_CLAIMED', retryAllowed: false }, origin)
        }
        let state = 'confirming'
        let transactionId = null
        const transition = async (nextState, details = {}) => {
          const saved = await ledger.transition({
            operationId, sessionId: session.sessionId, nextState,
            transactionId: details.transactionId || null,
            blockNumber: details.blockNumber || null,
            failureCode: details.failureCode || null,
            receipt: details.receipt || null,
          })
          state = saved.state
          return saved
        }
        try {
          const ownerAddress = String(env.TRON_OWNER_ADDRESS || '')
          const signer = signerFactory({ env })
          if (signer.address !== ownerAddress || signer.network !== 'TRON Mainnet') fail('OWNER_MANAGED_SIGNER_IDENTITY_MISMATCH', 403)
          const normalized = {
            operationType: claimed.operation_type,
            method: String(claimed.intent?.method || ''),
            args: claimed.intent?.args,
            feeLimitSun: String(claimed.intent?.feeLimitSun || ''),
          }
          const definition = Object.hasOwn(METHODS, normalized.operationType) ? METHODS[normalized.operationType] : null
          if (!definition || definition.method !== normalized.method || !Array.isArray(normalized.args)
            || !/^[1-9][0-9]{0,11}$/.test(normalized.feeLimitSun)) fail('OWNER_OPERATION_STORED_INTENT_INVALID', 409)
          const maxFee = BigInt(String(env.OWNER_MAX_FEE_LIMIT_SUN || '150000000'))
          if (BigInt(normalized.feeLimitSun) > maxFee) fail('OWNER_OPERATION_FEE_LIMIT_EXCEEDS_SERVER_CAP')
          const tronWeb = tronWebFactory({ fullHost: MAINNET })
          await verifyContractState(tronWeb, claimed.contract_address, ownerAddress, { fetchImpl: pacedFetch, env })
          const unsigned = await prepareTransaction(tronWeb, claimed.contract_address, ownerAddress, normalized)
          const freshPreflight = await preflightTransaction(tronWeb, unsigned, ownerAddress, claimed.contract_address, { fetchImpl: pacedFetch, env })
          const expiration = Number(unsigned?.raw_data?.expiration)
          if (!Number.isSafeInteger(expiration) || expiration <= Date.now() + 5_000) {
            fail('OWNER_OPERATION_TRANSACTION_EXPIRED_DURING_CONFIRMATION', 409)
          }
          verifyUnsignedTransaction(tronWeb, unsigned)
          const signed = await signer.signContractTransaction(unsigned)
          await verifySignedTransaction(tronWeb, signed, ownerAddress)
          transactionId = String(signed?.txID || '').toLowerCase()
          if (!TXID.test(transactionId) || transactionId !== String(unsigned.txID).toLowerCase()) {
            fail('OWNER_SIGNED_TRANSACTION_ID_MISMATCH', 409)
          }
          await transition('signed', {
            transactionId,
            receipt: { unsignedTransaction: unsigned, signedTransaction: signed, preflight: freshPreflight, intentSha256: intentHash },
          })
          await transition('broadcast-unknown')
          let broadcast
          try { broadcast = await broadcastTransaction(tronWeb, signed) } catch { broadcast = null }
          if (broadcast?.result === true) {
            const responseTxId = String(broadcast.txid || broadcast.txID || transactionId).toLowerCase()
            if (responseTxId !== transactionId) fail('OWNER_BROADCAST_TRANSACTION_ID_MISMATCH', 409)
            await transition('broadcast')
          }
          let reconciliation
          try { reconciliation = await reconcileTransaction(transactionId, ownerAddress, claimed.contract_address, { fetchImpl: pacedFetch, env, tronWeb }) }
          catch { reconciliation = { solidified: false, status: 'receipt-check-unavailable' } }
          if (reconciliation?.solidified && reconciliation.success === true) {
            await transition('confirmed', {
              blockNumber: reconciliation.blockNumber,
              receipt: { signedTransaction: signed, preflight: freshPreflight, reconciliation },
            })
            return reply(res, 200, {
              success: true, operationId, state, transactionId,
              blockNumber: reconciliation.blockNumber, result: reconciliation.status,
              solidified: true, retryAllowed: false,
            }, origin)
          }
          if (reconciliation?.solidified && reconciliation.success === false) {
            await transition('failed', {
              failureCode: String(reconciliation.status || 'SOLIDIFIED_EXECUTION_FAILED').slice(0, 100),
              blockNumber: reconciliation.blockNumber,
              receipt: { signedTransaction: signed, preflight: freshPreflight, reconciliation },
            })
            return reply(res, 422, {
              success: false, operationId, state, transactionId,
              blockNumber: reconciliation.blockNumber, result: reconciliation.status,
              solidified: true, retryAllowed: false,
            }, origin)
          }
          return reply(res, 202, {
            success: false, operationId, state, transactionId,
            solidified: false, reconciliation: reconciliation?.status || 'pending-or-unknown',
            note: 'The signed transaction is durably recorded. Do not retry or create a replacement operation. Refresh this operation to reconcile its Mainnet receipt.',
            retryAllowed: false,
          }, origin)
        } catch (error) {
          if (state === 'confirming') {
            await transition('failed', {
              failureCode: String(error?.code || error?.message || 'OWNER_OPERATION_CONFIRMATION_FAILED').slice(0, 100),
            }).catch(() => {})
          }
          return reply(res, Number.isInteger(error?.status) ? error.status : 503, {
            success: false, operationId, state, transactionId,
            error: String(error?.code || error?.message || 'OWNER_OPERATION_CONFIRMATION_FAILED').slice(0, 100),
            retryAllowed: false,
          }, origin)
        }
      }

      if (req.method === 'GET' && route && !action) {
        const operation = await ledger.get(operationId, session.sessionId)
        if (!operation) return reply(res, 404, { success: false, error: 'OWNER_OPERATION_NOT_FOUND' }, origin)
        let reconciliation = null
        if (operation.state === 'confirming' && !operation.transaction_id
          && Date.now() - new Date(operation.updated_at).getTime() > 5 * 60_000) {
          await ledger.transition({ operationId, sessionId: session.sessionId, nextState: 'failed', failureCode: 'OWNER_CONFIRMATION_INTERRUPTED_BEFORE_SIGN_PERSISTENCE' })
        }
        if (operation.transaction_id && ['signed', 'broadcast-unknown', 'broadcast'].includes(operation.state)) {
          const tronWeb = tronWebFactory({ fullHost: MAINNET })
          try {
            reconciliation = await reconcileTransaction(operation.transaction_id, String(env.TRON_OWNER_ADDRESS || ''), operation.contract_address, { fetchImpl: pacedFetch, env, tronWeb })
            if (reconciliation?.solidified) {
              if (operation.state === 'signed') {
                await ledger.transition({ operationId, sessionId: session.sessionId, nextState: 'broadcast-unknown' })
              }
              await ledger.transition({
                operationId, sessionId: session.sessionId,
                nextState: reconciliation.success ? 'confirmed' : 'failed',
                blockNumber: reconciliation.blockNumber,
                failureCode: reconciliation.success ? null : String(reconciliation.status || 'SOLIDIFIED_EXECUTION_FAILED').slice(0, 100),
                receipt: {
                  reconciliation, signedTransaction: operation.receipt?.signedTransaction,
                  preflight: operation.receipt?.preflight, intentSha256: operation.intent_sha256,
                },
              })
            }
          } catch { reconciliation = { solidified: false, status: 'receipt-check-unavailable' } }
        }
        const current = await ledger.get(operationId, session.sessionId)
        return reply(res, 200, {
          success: true,
          operation: {
            operationId: current.operation_id, operationType: current.operation_type,
            contractAddress: current.contract_address, state: current.state,
            intentSha256: String(current.intent_sha256 || '').trim(),
            transactionId: current.transaction_id || null, blockNumber: current.block_number || null,
            failureCode: current.failure_code || null, preflight: current.receipt?.preflight || null,
            method: current.intent?.method || null, args: current.intent?.args || null,
            feeLimitSun: current.intent?.feeLimitSun || null,
            confirmationPhrase: current.state === 'awaiting-confirmation' ? CONFIRMATION_PHRASE : null,
            createdAt: current.created_at, updatedAt: current.updated_at,
          },
          reconciliation: reconciliation
            ? { solidified: reconciliation.solidified === true, status: reconciliation.status || 'unknown', blockNumber: reconciliation.blockNumber || null }
            : { attempted: false },
          executionEnabled: executionGateEnabled(env),
        }, origin)
      }

      return reply(res, 405, { success: false, error: 'METHOD_NOT_ALLOWED' }, origin)
    } catch (error) {
      return reply(res, Number.isInteger(error?.status) ? error.status : 503, {
        success: false, error: String(error?.code || error?.message || 'OWNER_OPERATION_FAILED').slice(0, 100),
      }, origin)
    }
  }
  return Object.freeze({ handle })
}
