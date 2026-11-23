import { createHash, randomUUID } from 'node:crypto'
import { TronWeb } from 'tronweb'
import {
  createMainnetDeploymentTransaction,
  estimateMainnetDeploymentEnergy,
  getMainnetAccountResourceSnapshot,
} from '../src/trax-mainnet.mjs'
import {
  calculateDeploymentResourceBudget,
  assertZeroTrxBurnBudget,
  assertTransactionIntegrity,
} from '../src/tron-mainnet-preflight.mjs'
import { loadPinnedTRAXDeploymentArtifact } from './trax-deployment-artifact.mjs'

const OWNER = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const TXID = /^[0-9a-f]{64}$/i
const PHRASE = 'PREPARE TRӾ MAINNET DEPLOYMENT'
const MAINNET = 'https://api.trongrid.io'
const TATUM = 'https://tron-mainnet.gateway.tatum.io'
const sha256 = value => createHash('sha256').update(value).digest('hex')
function fail(code, status = 400) { throw Object.assign(new Error(code), { code, status }) }
function mainnetHost(env) {
  return env.TATUM_API_KEY && String(env.TATUM_TRON_NETWORK || 'mainnet').toLowerCase() === 'mainnet' ? TATUM : MAINNET
}
function durabilityReady(env) {
  return env.TRAX_DEPLOYMENT_LEDGER_DURABLE === 'true'
    && env.TRAX_DEPLOYMENT_LEDGER_BACKUP_VERIFIED === 'true'
    && env.TRAX_DEPLOYMENT_LEDGER_RESTORE_TESTED === 'true'
}
async function readBody(req) {
  const chunks = []; let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 8192) fail('TRAX_DEPLOYMENT_REQUEST_TOO_LARGE', 413)
    chunks.push(chunk)
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error()
    return body
  } catch { fail('TRAX_DEPLOYMENT_INVALID_JSON') }
}
function resourceFields(snapshot) {
  const energyAvailable = BigInt(snapshot.energyAvailable ?? 0)
  const freeBandwidthAvailable = BigInt(snapshot.freeBandwidthAvailable ?? 0)
  const stakedBandwidthAvailable = BigInt(snapshot.stakedBandwidthAvailable ?? 0)
  return {
    energyAvailable: energyAvailable.toString(),
    freeBandwidthAvailable: freeBandwidthAvailable.toString(),
    stakedBandwidthAvailable: stakedBandwidthAvailable.toString(),
    energyFeeSun: String(snapshot.energyFeeSun ?? ''),
    bandwidthFeeSun: snapshot.bandwidthFeeSun == null ? null : String(snapshot.bandwidthFeeSun),
    maxFeeLimitSun: snapshot.maxFeeLimitSun == null ? null : String(snapshot.maxFeeLimitSun),
  }
}

export function createTRAXDeploymentApi({
  env = process.env,
  send,
  database,
  authenticateManagedSession,
  artifactLoader = loadPinnedTRAXDeploymentArtifact,
  tronWebFactory = options => new TronWeb(options),
  buildTransaction = createMainnetDeploymentTransaction,
  estimateEnergy = estimateMainnetDeploymentEnergy,
  readResources = getMainnetAccountResourceSnapshot,
  calculateBudget = calculateDeploymentResourceBudget,
} = {}) {
  if (typeof send !== 'function' || typeof authenticateManagedSession !== 'function') throw new TypeError('TRӾ deployment API requires response and Owner-session adapters.')
  const mainnetEnabled = () => env.TRAX_DEPLOYMENT_EXECUTION_ENABLED === 'true'
    && env.TRAX_DEPLOYMENT_MAINNET_ACK === 'CONFIRM_ARTIFACT_PINNED_TRAX_DEPLOYMENT'
    && durabilityReady(env)

  async function checkDatabase() {
    if (!database || typeof database.query !== 'function') return false
    const result = await database.query("SELECT to_regclass('public.tron_transfer_deployments') AS deployments_table")
    return Boolean(result.rows?.[0]?.deployments_table)
  }
  async function handle(req, res, url, origin) {
    const readinessPath = url.pathname === '/api/owner/deployment/readiness'
    const preparePath = url.pathname === '/api/owner/deployment/prepare'
    const confirmPath = url.pathname === '/api/owner/deployment/confirm'
    if (!readinessPath && !preparePath && !confirmPath) return false
    if (req.method !== (readinessPath ? 'GET' : 'POST')) return send(res, 405, { error: 'METHOD_NOT_ALLOWED' }, origin)
    const session = await authenticateManagedSession(req, { requireCsrf: !readinessPath })
    if (!session?.address || !OWNER.test(session.address) || session.address !== env.TRON_OWNER_ADDRESS) {
      return send(res, 401, { error: 'OWNER_SESSION_REQUIRED' }, origin)
    }
    const ledgerReady = await checkDatabase().catch(() => false)
    const pinsConfigured = ['TRAX_SOURCE_SHA256','TRAX_CREATION_BYTECODE_SHA256','TRAX_RUNTIME_BYTECODE_SHA256','TRAX_DEPLOYMENT_ARTIFACT_SHA256']
      .every(name => /^[0-9a-f]{64}$/.test(String(env[name] || '')))
    let artifact = null
    let artifactError = null
    try { artifact = await artifactLoader({ env }) } catch (error) { artifactError = error?.code || 'TRAX_DEPLOYMENT_ARTIFACT_UNAVAILABLE' }
    const ready = Boolean(ledgerReady && durabilityReady(env) && artifact && session.address === env.TRON_OWNER_ADDRESS)
    if (readinessPath) {
      return send(res, 200, {
        success: true, network: 'TRON Mainnet', ownerAddress: session.address,
        artifact: artifact ? {
          contractName: artifact.contractName, compiler: artifact.compiler,
          sourceSha256: artifact.sourceSha256, creationBytecodeSha256: artifact.creationBytecodeSha256,
          runtimeBytecodeSha256: artifact.runtimeBytecodeSha256, artifactSha256: artifact.artifactSha256,
        } : null,
        gates: {
          databaseLedger: ledgerReady, ledgerDurable: env.TRAX_DEPLOYMENT_LEDGER_DURABLE === 'true',
          backupVerified: env.TRAX_DEPLOYMENT_LEDGER_BACKUP_VERIFIED === 'true',
          restoreTested: env.TRAX_DEPLOYMENT_LEDGER_RESTORE_TESTED === 'true',
          artifactPinsConfigured: pinsConfigured, artifactValid: Boolean(artifact),
          executionEnabled: mainnetEnabled(),
        },
        blocker: artifactError || (!ledgerReady ? 'TRAX_DEPLOYMENT_LEDGER_NOT_INSTALLED' : !durabilityReady(env) ? 'TRAX_DEPLOYMENT_LEDGER_DURABILITY_NOT_VERIFIED' : null),
        readyForPreparation: ready,
        executionEnabled: mainnetEnabled(),
        note: 'Readiness checks never sign or broadcast a Mainnet transaction.',
      }, origin)
    }
    if (confirmPath) {
      return send(res, 423, {
        error: 'TRAX_DEPLOYMENT_CONFIRMATION_NOT_IMPLEMENTED',
        message: 'Deployment signing and broadcast remain locked in this implementation increment. No transaction was signed or broadcast.',
      }, origin)
    }
    if (!ready) return send(res, 503, { error: artifactError || 'TRAX_DEPLOYMENT_PREPARATION_GATES_BLOCKED' }, origin)
    const body = await readBody(req)
    if (body.confirmationPhrase !== PHRASE) return send(res, 400, { error: 'TRAX_DEPLOYMENT_PREPARATION_PHRASE_INVALID' }, origin)
    const idempotencyKey = String(body.idempotencyKey || '')
    if (!/^[A-Za-z0-9._:-]{16,160}$/.test(idempotencyKey)) return send(res, 400, { error: 'TRAX_DEPLOYMENT_IDEMPOTENCY_KEY_INVALID' }, origin)
    const feeLimitSun = String(body.feeLimitSun || '')
    if (!/^[1-9][0-9]{0,11}$/.test(feeLimitSun)) return send(res, 400, { error: 'TRAX_DEPLOYMENT_FEE_LIMIT_INVALID' }, origin)
    const maxFeeLimitSun = BigInt(env.TRAX_DEPLOYMENT_MAX_FEE_LIMIT_SUN || '150000000')
    if (BigInt(feeLimitSun) > maxFeeLimitSun) return send(res, 400, { error: 'TRAX_DEPLOYMENT_FEE_LIMIT_ABOVE_POLICY' }, origin)
    try {
      const artifactNow = await artifactLoader({ env })
      const tronWeb = tronWebFactory({ fullHost: mainnetHost(env) })
      const unsigned = await buildTransaction(tronWeb, {
        abi: artifactNow.abi, bytecode: artifactNow.bytecode, feeLimit: Number(feeLimitSun),
        originEnergyLimit: Number(env.TRAX_DEPLOYMENT_ORIGIN_ENERGY_LIMIT || 10000000),
        name: 'TRӾ', callValue: 0, userFeePercentage: 100,
      }, session.address)
      assertTransactionIntegrity(tronWeb, unsigned, 'TRӾ CreateSmartContract transaction')
      const contract = unsigned?.raw_data?.contract?.[0]
      const value = contract?.parameter?.value || {}
      const newContract = value.new_contract || {}
      const ownerHex = tronWeb.address.toHex(session.address).toLowerCase()
      if (contract?.type !== 'CreateSmartContract'
        || String(value.owner_address || '').toLowerCase() !== ownerHex
        || String(newContract.bytecode || '').replace(/^0x/i, '').toLowerCase() !== artifactNow.bytecode.toLowerCase()
        || !Array.isArray(newContract.abi?.entrys) || newContract.abi.entrys.length !== artifactNow.abi.length
        || !TXID.test(String(unsigned.txID || ''))) fail('TRAX_DEPLOYMENT_UNSIGNED_TRANSACTION_MISMATCH', 409)
      const [estimate, snapshot, balanceSun] = await Promise.all([
        estimateEnergy(tronWeb, session.address, artifactNow),
        readResources(tronWeb, session.address),
        tronWeb.trx.getBalance(session.address).then(value => String(value)),
      ])
      const resource = resourceFields(snapshot)
      const budget = calculateBudget({
        energyRequired: estimate.energyUsed,
        resourceSnapshot: resource,
        rawDataHex: unsigned.raw_data_hex,
        feeLimitSun,
        safetyMarginBps: 12500,
        transactionLabel: 'TRӾ deployment',
      })
      assertZeroTrxBurnBudget(budget)
      if (BigInt(balanceSun) < 0n) fail('TRAX_DEPLOYMENT_OWNER_BALANCE_INVALID', 503)
      const intent = {
        ownerAddress: session.address, network: 'TRON Mainnet',
        artifactSha256: artifactNow.artifactSha256,
        sourceSha256: artifactNow.sourceSha256,
        creationBytecodeSha256: artifactNow.creationBytecodeSha256,
        runtimeBytecodeSha256: artifactNow.runtimeBytecodeSha256,
        feeLimitSun, txID: unsigned.txID,
      }
      const intentSha256 = sha256(JSON.stringify(intent))
      const operationId = randomUUID()
      const inserted = await database.query(`
        INSERT INTO public.tron_transfer_deployments
          (operation_id,owner_address,idempotency_key,intent,intent_sha256,artifact_sha256,
           creation_bytecode_sha256,runtime_bytecode_sha256,transaction_id,unsigned_transaction,
           preflight,state)
        VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,'prepared')
        ON CONFLICT (owner_address,idempotency_key) DO NOTHING
        RETURNING operation_id,state,transaction_id,created_at
      `, [
        operationId, session.address, idempotencyKey, JSON.stringify(intent), intentSha256,
        artifactNow.artifactSha256, artifactNow.creationBytecodeSha256, artifactNow.runtimeBytecodeSha256,
        unsigned.txID, JSON.stringify(unsigned), JSON.stringify({
          estimate, resources: resource, ownerBalanceSun: balanceSun, budget, checkedAt: new Date().toISOString(),
        }),
      ])
      if (!inserted.rows?.[0]) {
        const existing = await database.query(
          'SELECT operation_id,state,transaction_id,intent_sha256 FROM public.tron_transfer_deployments WHERE owner_address=$1 AND idempotency_key=$2',
          [session.address, idempotencyKey],
        )
        const row = existing.rows?.[0]
        if (!row || row.intent_sha256 !== intentSha256) fail('TRAX_DEPLOYMENT_IDEMPOTENCY_CONFLICT', 409)
        return send(res, 200, { success: true, replay: true, deployment: row }, origin)
      }
      return send(res, 201, {
        success: true, replay: false, deployment: inserted.rows[0],
        intent, intentSha256, preflight: { estimate, resources: resource, ownerBalanceSun: balanceSun, budget },
        confirmationPhrase: 'CONFIRM TRӾ MAINNET DEPLOYMENT',
        message: 'Unsigned deployment transaction and exact artifact fingerprints are durably recorded. No signature or broadcast was requested.',
      }, origin)
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 503
      return send(res, status, { error: error?.code || 'TRAX_DEPLOYMENT_PREPARATION_FAILED', message: String(error?.message || 'TRӾ deployment preparation failed').slice(0, 260) }, origin)
    }
  }
  return Object.freeze({ handle })
}
