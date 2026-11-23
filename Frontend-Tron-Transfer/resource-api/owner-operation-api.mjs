import { TronWeb } from 'tronweb'
import pg from 'pg'
import { createOwnerOperationLedger } from './owner-operation-ledger.mjs'
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
  'owner-issue': { method: 'mint', args: input => [input.ownerAddress, uint(input.amount)] },
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
  'ownership-transfer': { method: 'transferOwnership', args: input => [address(input.nextOwner)] },
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
  const definition = METHODS[operationType]
  if (!definition) fail('OWNER_OPERATION_NOT_ALLOWLISTED')
  const args = definition.args({ ...input, ownerAddress })
  const feeLimitSun = String(input.feeLimitSun ?? '')
  if (!/^[1-9][0-9]{0,11}$/.test(feeLimitSun)) fail('OWNER_OPERATION_FEE_LIMIT_INVALID')
  const idempotencyKey = String(input.idempotencyKey || '')
  if (!/^[A-Za-z0-9._:-]{16,160}$/.test(idempotencyKey)) fail('OWNER_OPERATION_IDEMPOTENCY_KEY_INVALID')
  return { operationType, method: definition.method, args, feeLimitSun, idempotencyKey }
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
  if (!response.ok || result?.Error || result?.error) fail('OWNER_MAINNET_RPC_UNAVAILABLE', 503)
  return result
}
function available(limit, used) {
  const a = BigInt(String(limit || '0')), b = BigInt(String(used || '0'))
  return a > b ? a - b : 0n
}
function asAddress(tronWeb, value) {
  try { return value && (String(value).startsWith('T') ? value : tronWeb.address.fromHex(value)) } catch { return '' }
}
function verifyPermission(tronWeb, account, ownerAddress) {
  const permission = account?.owner_permission
  const threshold = Number(permission?.threshold)
  if (!permission || !Number.isSafeInteger(threshold) || threshold <= 0 || !Array.isArray(permission.keys)) {
    fail('OWNER_MAINNET_OWNER_PERMISSION_UNAVAILABLE', 503)
  }
  const weight = permission.keys.reduce((sum, item) => {
    const keyAddress = asAddress(tronWeb, item?.address)
    return keyAddress === ownerAddress ? sum + Number(item?.weight || 0) : sum
  }, 0)
  if (!Number.isSafeInteger(weight) || weight < threshold) fail('OWNER_SIGNER_CANNOT_SATISFY_OWNER_PERMISSION', 403)
  return { permissionId: 0, threshold, signerWeight: weight, satisfied: true }
}
async function verifyContract(tronWeb, contractAddress, ownerAddress) {
  const contract = await tronWeb.contract(ABI).at(contractAddress)
  const [name, symbol, decimals, owner] = await Promise.all([
    contract.name().call(), contract.symbol().call(), contract.decimals().call(), contract.owner().call(),
  ])
  if (String(name) !== 'TRӾ' || String(symbol) !== 'TRӾ' || Number(decimals) !== 6) fail('OWNER_TRAX_CONTRACT_METADATA_MISMATCH', 409)
  if (asAddress(tronWeb, owner) !== ownerAddress) fail('OWNER_NOT_CURRENT_ONCHAIN_CONTRACT_OWNER', 403)
  return { name: String(name), symbol: String(symbol), decimals: Number(decimals), owner: ownerAddress }
}
async function buildUnsigned(tronWeb, contractAddress, ownerAddress, normalized) {
  const abi = ABI.find(item => item.type === 'function' && item.name === normalized.method)
  if (!abi) fail('OWNER_OPERATION_ABI_METHOD_MISSING', 500)
  const signature = normalized.method + '(' + abi.inputs.map(item => item.type).join(',') + ')'
  const built = await tronWeb.transactionBuilder.triggerSmartContract(
    contractAddress,
    signature,
    { feeLimit: Number(normalized.feeLimitSun), callValue: 0, from: ownerAddress, funcABIV2: abi, parametersV2: normalized.args },
    [],
    tronWeb.address.toHex(ownerAddress),
  )
  const transaction = built?.transaction || built
  if (built?.result?.result !== true || !TXID.test(String(transaction?.txID || ''))
    || !/^(?:[0-9a-f]{2})+$/i.test(String(transaction?.raw_data_hex || ''))
    || transaction?.raw_data?.contract?.length !== 1
    || transaction.raw_data.contract[0]?.type !== 'TriggerSmartContract') fail('OWNER_UNSIGNED_TRANSACTION_BUILD_FAILED', 503)
  const value = transaction.raw_data.contract[0]?.parameter?.value || {}
  if (Number(transaction.raw_data?.contract?.[0]?.Permission_id ?? 0) !== 0
    || asAddress(tronWeb, value.owner_address) !== ownerAddress
    || asAddress(tronWeb, value.contract_address) !== contractAddress
    || Number(value.call_value || 0) !== 0
    || !String(value.data || '').toLowerCase().startsWith(String(tronWeb.sha3(signature)).replace(/^0x/i, '').slice(0, 8).toLowerCase())) {
    fail('OWNER_UNSIGNED_TRANSACTION_INTENT_MISMATCH', 409)
  }
  return safeJson(transaction)
}
async function preflight(tronWeb, transaction, ownerAddress, contractAddress, { fetchImpl, env }) {
  const value = transaction.raw_data.contract[0].parameter.value
  const [resource, account, parameters] = await Promise.all([
    rpcPost('/wallet/getaccountresource', { address: ownerAddress, visible: true }, { fetchImpl, env }),
    rpcPost('/wallet/getaccount', { address: ownerAddress, visible: true }, { fetchImpl, env }),
    rpcPost('/wallet/getchainparameters', {}, { fetchImpl, env }),
  ])
  const data = String(value.data || '').replace(/^0x/i, '')
  let energyResult
  try {
    energyResult = await rpcPost('/wallet/estimateenergy', {
      owner_address: tronWeb.address.toHex(ownerAddress),
      contract_address: tronWeb.address.toHex(contractAddress),
      data, call_value: 0, visible: false,
    }, { fetchImpl, env })
  } catch {
    energyResult = await rpcPost('/wallet/triggerconstantcontract', {
      owner_address: tronWeb.address.toHex(ownerAddress),
      contract_address: tronWeb.address.toHex(contractAddress),
      data, call_value: 0, visible: false,
    }, { fetchImpl, env })
  }
  const energyRaw = energyResult?.energy_required ?? energyResult?.energy_used
  if (!Number.isSafeInteger(Number(energyRaw)) || Number(energyRaw) <= 0
    || energyResult?.result?.result === false) fail('OWNER_ENERGY_ESTIMATE_UNAVAILABLE', 503)
  const chain = Object.fromEntries((parameters.chainParameter || []).map(item => [item.key, String(item.value)]))
  const energyAvailable = available(resource.EnergyLimit, resource.EnergyUsed)
  const freeBandwidth = available(resource.freeNetLimit, resource.freeNetUsed)
  const stakedBandwidth = available(resource.NetLimit, resource.NetUsed)
  const bandwidthAvailable = freeBandwidth > stakedBandwidth ? freeBandwidth : stakedBandwidth
  const requiredEnergy = (BigInt(String(energyRaw)) * 12500n + 9999n) / 10000n
  const transactionBytes = BigInt(Buffer.from(transaction.raw_data_hex, 'hex').length + 100)
  const energyShortfall = requiredEnergy > energyAvailable ? requiredEnergy - energyAvailable : 0n
  const bandwidthShortfall = transactionBytes > bandwidthAvailable ? transactionBytes - bandwidthAvailable : 0n
  const energyFee = BigInt(chain.getEnergyFee || '0')
  const bandwidthFee = BigInt(chain.getTransactionFee || '0')
  if (energyFee <= 0n || bandwidthFee <= 0n) fail('OWNER_MAINNET_CHAIN_FEES_UNAVAILABLE', 503)
  const estimatedTrxFallbackSun = energyShortfall * energyFee + bandwidthShortfall * bandwidthFee
  const permission = verifyPermission(tronWeb, account, ownerAddress)
  const txId = String(transaction.txID).toLowerCase()
  if (!TXID.test(txId)) fail('OWNER_UNSIGNED_TRANSACTION_ID_INVALID', 500)
  if (estimatedTrxFallbackSun !== 0n) {
    fail('OWNER_ZERO_TRX_BURN_PREFLIGHT_BLOCKED', 423)
  }
  return {
    network: 'TRON Mainnet', ownerAddress, contractAddress, permission,
    estimatedEnergy: String(energyRaw), requiredEnergyWithSafetyMargin: requiredEnergy.toString(),
    availableEnergy: energyAvailable.toString(), transactionBytes: transactionBytes.toString(),
    availableBandwidth: bandwidthAvailable.toString(), estimatedTrxFallbackSun: estimatedTrxFallbackSun.toString(),
    feeLimitSun: String(transaction.raw_data.fee_limit), txID: txId,
    accountBalanceSun: String(account.balance ?? '0'), checkedAt: new Date().toISOString(),
  }
}

export function createOwnerOperationApi({
  env = process.env, send, authenticateManagedSession, database = null,
  fetchImpl = fetch, tronWebFactory = options => new TronWeb(options),
  prepareTransaction = buildUnsigned, preflightTransaction = preflight,
} = {}) {
  if (typeof send !== 'function' || typeof authenticateManagedSession !== 'function') throw new TypeError('Owner operation API dependencies are required')
  let pool = database
  function getDatabase() {
    if (pool) return pool
    const connection = sponsorDatabaseConnectionString(env)
    if (!connection) return null
    pool = new Pool({ connectionString: normalizePostgresTlsMode(connection), connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000, max: 3 })
    pool.on('error', error => process.stderr.write('Owner operation ledger database error: ' + String(error?.code || 'unknown') + '\\n'))
    return pool
  }
  const reply = (res, status, payload, origin) => { send(res, status, payload, origin); return true }
  async function handle(req, res, url, origin) {
    const path = url.pathname
    if (path !== '/api/owner/operations/prepare' && !/^\\/api\\/owner\\/operations\\/[0-9a-f-]{36}$/i.test(path)) return false
    const session = await authenticateManagedSession(req, { requireCsrf: req.method !== 'GET' })
    if (!session || session.address !== env.TRON_OWNER_ADDRESS) return reply(res, 401, { success: false, error: 'OWNER_SESSION_REQUIRED' }, origin)
    const db = getDatabase()
    if (!db) return reply(res, 503, { success: false, error: 'OWNER_OPERATION_LEDGER_UNAVAILABLE' }, origin)
    if (env.OWNER_OPERATION_LEDGER_DURABLE !== 'true'
      || env.OWNER_OPERATION_LEDGER_BACKUP_VERIFIED !== 'true'
      || env.OWNER_OPERATION_LEDGER_RESTORE_TESTED !== 'true') {
      return reply(res, 503, { success: false, error: 'OWNER_OPERATION_LEDGER_DURABILITY_NOT_VERIFIED' }, origin)
    }
    try {
      const schema = await db.query("SELECT to_regclass('public.tron_transfer_owner_operations') AS operations_table")
      if (!schema.rows?.[0]?.operations_table) return reply(res, 503, { success: false, error: 'OWNER_OPERATION_LEDGER_SCHEMA_NOT_INITIALIZED' }, origin)
      const ledger = createOwnerOperationLedger({ database: db })
      if (req.method === 'POST' && path === '/api/owner/operations/prepare') {
        const input = await readBody(req)
        const ownerAddress = String(env.TRON_OWNER_ADDRESS || '')
        const contractAddress = String(env.TRAX_CONTRACT_ADDRESS || '')
        if (!ADDRESS.test(ownerAddress) || !ADDRESS.test(contractAddress)) return reply(res, 503, { success: false, error: 'OWNER_MAINNET_IDENTITY_OR_TRAX_CONTRACT_NOT_CONFIGURED' }, origin)
        const normalized = normalizeIntent(input, ownerAddress)
        const maxFee = BigInt(String(env.OWNER_MAX_FEE_LIMIT_SUN || '150000000'))
        if (BigInt(normalized.feeLimitSun) > maxFee) fail('OWNER_OPERATION_FEE_LIMIT_EXCEEDS_SERVER_CAP')
        const record = await ledger.prepare({
          sessionId: session.sessionId, idempotencyKey: normalized.idempotencyKey,
          operationType: normalized.operationType, contractAddress,
          intent: { method: normalized.method, args: normalized.args, feeLimitSun: normalized.feeLimitSun },
        })
        if (record.replay) return reply(res, 200, {
          success: true, replay: true, operationId: record.operation_id, state: record.state,
          transactionId: record.transaction_id || null, retryAllowed: false,
          note: 'This idempotency key already identifies the same durable Owner intent. It was not rebuilt or resubmitted.',
        }, origin)
        let transaction
        let result
        try {
          const tronWeb = tronWebFactory({ fullHost: MAINNET })
          await verifyContract(tronWeb, contractAddress, ownerAddress)
          transaction = await prepareTransaction(tronWeb, contractAddress, ownerAddress, normalized)
          result = await preflightTransaction(tronWeb, transaction, ownerAddress, contractAddress, { fetchImpl, env })
        } catch (error) {
          await ledger.transition({
            operationId: record.operation_id, sessionId: session.sessionId,
            nextState: 'failed', failureCode: String(error?.code || error?.message || 'OWNER_PREFLIGHT_FAILED').slice(0, 100),
          }).catch(() => {})
          throw error
        }
        await ledger.transition({ operationId: record.operation_id, sessionId: session.sessionId, nextState: 'preflight-passed', receipt: { unsignedTransaction: transaction, preflight: result } })
        await ledger.transition({ operationId: record.operation_id, sessionId: session.sessionId, nextState: 'awaiting-confirmation' })
        return reply(res, 201, {
          success: true, replay: false, operationId: record.operation_id, state: 'awaiting-confirmation',
          operationType: normalized.operationType, method: normalized.method, args: normalized.args,
          ownerAddress, contractAddress, preflight: result, confirmationPhrase: CONFIRMATION_PHRASE,
          transactionExpiresAt: transaction.raw_data?.expiration || null,
          executionEnabled: false,
          note: 'This endpoint prepares and durably records the exact operation only. Signing and broadcasting are intentionally disabled in this release.',
        }, origin)
      }
      const match = path.match(/^\\/api\\/owner\\/operations\\/([0-9a-f-]{36})$/i)
      if (req.method === 'GET' && match) {
        const operation = await ledger.get(match[1], session.sessionId)
        if (!operation) return reply(res, 404, { success: false, error: 'OWNER_OPERATION_NOT_FOUND' }, origin)
        return reply(res, 200, {
          success: true, operation: {
            operationId: operation.operation_id, operationType: operation.operation_type,
            contractAddress: operation.contract_address, state: operation.state,
            transactionId: operation.transaction_id || null, failureCode: operation.failure_code || null,
            createdAt: operation.created_at, updatedAt: operation.updated_at,
          }, executionEnabled: false,
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
