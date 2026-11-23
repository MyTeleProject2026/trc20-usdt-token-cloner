import { createHash, randomUUID } from 'node:crypto'
import { TronWeb } from 'tronweb'
import pg from 'pg'
import { sponsorDatabaseConnectionString } from './sponsor-api.mjs'
import { normalizePostgresTlsMode } from './scripts/sponsor-ledger-database-identity.mjs'
import {
  createMainnetDeploymentTransaction,
  estimateMainnetDeploymentEnergy,
  getMainnetAccountResourceSnapshot,
  getMainnetNativeBalance,
} from '../src/trax-mainnet.mjs'
import {
  calculateDeploymentResourceBudget,
  assertZeroTrxBurnBudget,
  assertTransactionIntegrity,
  verifyTransactionSigner,
  assertTransactionPermission,
} from '../src/tron-mainnet-preflight.mjs'
import { loadPinnedTRAXDeploymentArtifact } from './trax-deployment-artifact.mjs'
import { predictMainnetContractAddress, recoverMainnetDeployment, waitForSolidifiedReceipt } from '../src/trax-mainnet.mjs'

const { Pool } = pg
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
  assertBudget = assertZeroTrxBurnBudget,
  assertIntegrity = assertTransactionIntegrity,
  verifySigner = verifyTransactionSigner,
  verifyPermission = assertTransactionPermission,
  predictAddress = predictMainnetContractAddress,
  recoverDeployment = recoverMainnetDeployment,
  signDeployment = (client, unsigned) => client.trx.sign(unsigned),
  broadcastDeployment = (client, signed) => client.trx.sendRawTransaction(signed),
} = {}) {
  if (typeof send !== 'function' || typeof authenticateManagedSession !== 'function') throw new TypeError('TRӾ deployment API requires response and Owner-session adapters.')
  let pool = database
  async function getDatabase() {
    if (pool) return pool
    const connection = sponsorDatabaseConnectionString(env)
    if (!connection) return null
    pool = new Pool({ connectionString: normalizePostgresTlsMode(connection), connectionTimeoutMillis: 2500, query_timeout: 2500, statement_timeout: 2000, idleTimeoutMillis: 30000, max: 3 })
    pool.on('error', error => process.stderr.write('TRӾ deployment ledger database error: ' + String(error?.code || 'unknown') + '\\n'))
    return pool
  }
  const mainnetEnabled = () => env.TRAX_DEPLOYMENT_EXECUTION_ENABLED === 'true'
    && env.TRAX_DEPLOYMENT_MAINNET_ACK === 'CONFIRM_ARTIFACT_PINNED_TRAX_DEPLOYMENT'
    && durabilityReady(env)

  async function checkDatabase(db) {
    if (!db || typeof db.query !== 'function') return false
    const result = await db.query("SELECT to_regclass('public.tron_transfer_deployments') AS deployments_table")
    return Boolean(result.rows?.[0]?.deployments_table)
  }
  async function handle(req, res, url, origin) {
    const readinessPath = url.pathname === '/api/owner/deployment/readiness'
    const preparePath = url.pathname === '/api/owner/deployment/prepare'
    const confirmPath = url.pathname === '/api/owner/deployment/confirm'
    const statusMatch = url.pathname.match(/^\/api\/owner\/deployment\/([0-9a-f-]{36})$/i)
    const statusPath = Boolean(statusMatch)
    if (!readinessPath && !preparePath && !confirmPath && !statusPath) return false
    if (req.method !== (readinessPath || statusPath ? 'GET' : 'POST')) return send(res, 405, { error: 'METHOD_NOT_ALLOWED' }, origin)
    const session = await authenticateManagedSession(req, { requireCsrf: !readinessPath && !statusPath })
    if (!session?.address || !OWNER.test(session.address) || session.address !== env.TRON_OWNER_ADDRESS) {
      return send(res, 401, { error: 'OWNER_SESSION_REQUIRED' }, origin)
    }
    const db = await getDatabase().catch(() => null)
    const ledgerReady = await checkDatabase(db).catch(() => false)
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
    if (statusPath) {
      if (!db || !ledgerReady) return send(res, 503, { error: 'TRAX_DEPLOYMENT_LEDGER_DATABASE_UNAVAILABLE' }, origin)
      const rowResult = await db.query(
        'SELECT operation_id,owner_address,idempotency_key,intent,intent_sha256,artifact_sha256,transaction_id,preflight,receipt,contract_address,state,failure_code,created_at,updated_at,signed_at,broadcast_at,confirmed_at FROM public.tron_transfer_deployments WHERE operation_id=$1 AND owner_address=$2',
        [statusMatch[1], session.address],
      )
      const row = rowResult.rows?.[0]
      if (!row) return send(res, 404, { error: 'TRAX_DEPLOYMENT_NOT_FOUND' }, origin)
      // Keep signed/raw transaction payloads server-side; the browser only needs
      // the transaction ID, predicted address, state and verified receipt.
      const { unsigned_transaction: _unsignedTransaction, signed_transaction: _signedTransaction, ...publicRow } = row
      if (['signed','broadcast-unknown','broadcast'].includes(row.state)) {
        try {
          const artifactNow = await artifactLoader({ env })
          if (artifactNow.artifactSha256 !== row.artifact_sha256) fail('TRAX_DEPLOYMENT_ARTIFACT_CHANGED', 409)
          const tronWeb = tronWebFactory({ fullHost: mainnetHost(env) })
          tronWeb.fullNode.headers = env.TATUM_API_KEY && String(env.TATUM_TRON_NETWORK || 'mainnet').toLowerCase() === 'mainnet'
            ? { 'x-api-key': String(env.TATUM_API_KEY).trim() }
            : (env.TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': String(env.TRONGRID_API_KEY).trim() } : {})
          const recovered = await recoverDeployment(tronWeb, {
            txID: row.transaction_id, ownerAddress: session.address, artifact: artifactNow,
          }, {
            waitForReceipt: (client, txID) => waitForSolidifiedReceipt(client, txID, { timeoutMs: 25000, intervalMs: 2500 }),
          })
          const saved = await db.query(`
            UPDATE public.tron_transfer_deployments
            SET state='confirmed',contract_address=$2,receipt=$3::jsonb,
                confirmed_at=now(),updated_at=now(),failure_code=NULL
            WHERE operation_id=$1 AND owner_address=$4
              AND state IN ('signed','broadcast-unknown','broadcast')
            RETURNING operation_id,state,transaction_id,contract_address,receipt,confirmed_at
          `, [row.operation_id, recovered.address, JSON.stringify(recovered), session.address])
          if (!saved.rows?.[0]) {
            const current = await db.query(
              'SELECT operation_id,state,transaction_id,contract_address,receipt,confirmed_at FROM public.tron_transfer_deployments WHERE operation_id=$1 AND owner_address=$2',
              [row.operation_id, session.address],
            )
            if (current.rows?.[0]?.state !== 'confirmed') fail('TRAX_DEPLOYMENT_CONFIRMATION_NOT_DURABLY_PERSISTED', 503)
            return send(res, 200, { success: true, deployment: current.rows[0], recovery: { available: false, solidified: true, runtimeBytecodeVerified: true, ownerVerified: true, metadataVerified: true, automaticRebroadcast: false } }, origin)
          }
          return send(res, 200, {
            success: true, deployment: saved.rows[0],
            recovery: { available: false, solidified: true, runtimeBytecodeVerified: true, ownerVerified: true, metadataVerified: true, automaticRebroadcast: false },
          }, origin)
        } catch (error) {
          return send(res, 202, {
            success: true, deployment: publicRow,
            recovery: { available: true, solidified: false, automaticRebroadcast: false },
            message: String(error?.message || 'Solidified Mainnet receipt is not yet available. Keep the original transaction ID and retry status recovery.').slice(0,240),
          }, origin)
        }
      }
      return send(res, 200, { success: true, deployment: publicRow, recovery: { available: false, automaticRebroadcast: false } }, origin)
    }
    if (confirmPath) {
      if (!db || !ledgerReady) return send(res, 503, { error: 'TRAX_DEPLOYMENT_LEDGER_NOT_READY' }, origin)
      const body = await readBody(req)
      const operationId = String(body.operationId || '')
      const intentSha256 = String(body.intentSha256 || '')
      if (!/^[0-9a-f-]{36}$/i.test(operationId) || !/^[0-9a-f]{64}$/.test(intentSha256)
        || body.confirmationPhrase !== 'CONFIRM TRӾ MAINNET DEPLOYMENT') {
        return send(res, 400, { error: 'TRAX_DEPLOYMENT_CONFIRMATION_INVALID' }, origin)
      }
      if (!mainnetEnabled()) return send(res, 423, { error: 'TRAX_DEPLOYMENT_EXECUTION_GATES_LOCKED', message: 'Execution requires explicit Mainnet enablement plus verified ledger backup and restore gates.' }, origin)
      let claimed
      try {
        const claim = await db.query(`
          UPDATE public.tron_transfer_deployments
          SET state='confirming',updated_at=now()
          WHERE operation_id=$1 AND owner_address=$2 AND intent_sha256=$3 AND state='prepared'
          RETURNING *
        `, [operationId, session.address, intentSha256])
        claimed = claim.rows?.[0]
        if (!claimed) {
          const existing = await db.query(
            'SELECT operation_id,state,transaction_id,contract_address,receipt,failure_code FROM public.tron_transfer_deployments WHERE operation_id=$1 AND owner_address=$2',
            [operationId, session.address],
          )
          if (!existing.rows?.[0]) return send(res, 404, { error: 'TRAX_DEPLOYMENT_NOT_FOUND' }, origin)
          return send(res, 409, { error: 'TRAX_DEPLOYMENT_NOT_CONFIRMABLE', deployment: existing.rows[0], automaticRebroadcast: false }, origin)
        }
        const artifactNow = await artifactLoader({ env })
        if (artifactNow.artifactSha256 !== claimed.artifact_sha256
          || artifactNow.creationBytecodeSha256 !== claimed.creation_bytecode_sha256
          || artifactNow.runtimeBytecodeSha256 !== claimed.runtime_bytecode_sha256) fail('TRAX_DEPLOYMENT_ARTIFACT_CHANGED', 409)
        const key = String(env.TRON_OWNER_PRIVATE_KEY || '').trim().replace(/^0x/i, '')
        if (!/^[0-9a-f]{64}$/i.test(key)) fail('TRAX_DEPLOYMENT_OWNER_SIGNER_NOT_CONFIGURED', 503)
        const tronWeb = tronWebFactory({ fullHost: mainnetHost(env), privateKey: key })
        tronWeb.fullNode.headers = env.TATUM_API_KEY && String(env.TATUM_TRON_NETWORK || 'mainnet').toLowerCase() === 'mainnet'
          ? { 'x-api-key': String(env.TATUM_API_KEY).trim() }
          : (env.TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': String(env.TRONGRID_API_KEY).trim() } : {})
        const derivedOwner = tronWeb.address.fromPrivateKey(key)
        if (derivedOwner !== session.address || derivedOwner !== env.TRON_OWNER_ADDRESS) fail('TRAX_DEPLOYMENT_SIGNER_OWNER_MISMATCH', 403)
        const unsigned = claimed.unsigned_transaction
        assertIntegrity(tronWeb, unsigned, 'Persisted TRӾ deployment transaction')
        const contract = unsigned?.raw_data?.contract?.[0]
        const value = contract?.parameter?.value || {}
        const newContract = value.new_contract || {}
        const ownerHex = tronWeb.address.toHex(session.address).toLowerCase()
        const calculatedTxId = sha256(Buffer.from(String(unsigned.raw_data_hex), 'hex'))
        if (contract?.type !== 'CreateSmartContract'
          || String(value.owner_address || '').toLowerCase() !== ownerHex
          || String(newContract.bytecode || '').replace(/^0x/i, '').toLowerCase() !== artifactNow.bytecode.toLowerCase()
          || JSON.stringify(newContract.abi?.entrys || []) !== JSON.stringify(artifactNow.abi)
          || Number(value.call_value || 0) !== 0
          || Number(unsigned.raw_data?.fee_limit || 0) !== Number(claimed.intent.feeLimitSun)
          || Number(unsigned.raw_data?.timestamp || 0) > Date.now() + 30000
          || String(unsigned.txID || '').toLowerCase() !== calculatedTxId
          || Number(unsigned.raw_data?.expiration || 0) <= Date.now() + 5000
          || Number(unsigned.raw_data?.expiration || 0) > Date.now() + 10 * 60_000) fail('TRAX_DEPLOYMENT_PERSISTED_TRANSACTION_INVALID', 409)
        const predictedAddress = predictAddress(tronWeb, session.address, unsigned.txID)
        const signed = await signDeployment(tronWeb, unsigned)
        if (!Array.isArray(signed?.signature) || signed.signature.length !== 1
          || !/^[0-9a-f]{130}$/i.test(String(signed.signature[0] || ''))
          || String(signed.txID || '').toLowerCase() !== String(unsigned.txID).toLowerCase()
          || String(signed.raw_data_hex || '').toLowerCase() !== String(unsigned.raw_data_hex).toLowerCase()) {
          fail('TRAX_DEPLOYMENT_SIGNED_TRANSACTION_MISMATCH', 409)
        }
        assertIntegrity(tronWeb, signed, 'Signed TRӾ CreateSmartContract transaction')
        verifySigner(tronWeb, signed, session.address)
        await verifyPermission(tronWeb, signed, session.address)
        const [freshEstimate, freshSnapshot] = await Promise.all([
          estimateEnergy(tronWeb, session.address, artifactNow),
          readResources(tronWeb, session.address),
        ])
        const freshBudget = calculateBudget({
          energyRequired: freshEstimate.energyUsed,
          resourceSnapshot: resourceFields(freshSnapshot),
          rawDataHex: signed.raw_data_hex,
          feeLimitSun: String(claimed.intent.feeLimitSun),
          safetyMarginBps: 12500,
          transactionLabel: 'TRӾ deployment final signed pre-broadcast check',
        })
        assertBudget(freshBudget)
        const persisted = await db.query(`
          UPDATE public.tron_transfer_deployments
          SET signed_transaction=$2::jsonb,state='signed',signed_at=now(),updated_at=now()
          WHERE operation_id=$1 AND owner_address=$3 AND state='confirming'
          RETURNING operation_id,state,transaction_id
        `, [operationId, JSON.stringify(signed), session.address])
        if (!persisted.rows?.[0]) fail('TRAX_DEPLOYMENT_SIGNED_TRANSACTION_NOT_PERSISTED', 503)
        const beforeBroadcast = await db.query(`
          UPDATE public.tron_transfer_deployments
          SET state='broadcast-unknown',contract_address=$2,updated_at=now()
          WHERE operation_id=$1 AND owner_address=$3 AND state='signed'
          RETURNING operation_id,state,transaction_id
        `, [operationId, predictedAddress, session.address])
        if (!beforeBroadcast.rows?.[0]) fail('TRAX_DEPLOYMENT_BROADCAST_INTENT_NOT_PERSISTED', 503)
        // The durable broadcast-unknown state is committed before the network call.
        // If the response is lost or the process crashes, recovery checks this txID;
        // it never creates a replacement transaction or automatically rebroadcasts.
        let broadcast
        try { broadcast = await broadcastDeployment(tronWeb, signed) } catch (error) {
          await db.query(
            "UPDATE public.tron_transfer_deployments SET failure_code=$2,updated_at=now() WHERE operation_id=$1 AND state='broadcast-unknown'",
            [operationId, String(error?.code || 'BROADCAST_RESPONSE_UNKNOWN').slice(0,120)],
          ).catch(() => {})
          return send(res, 202, { success: true, deployment: { operationId, state: 'broadcast-unknown', transactionId: unsigned.txID, contractAddress: predictedAddress }, recovery: { available: true, automaticRebroadcast: false }, message: 'Broadcast response was ambiguous. The original transaction ID is persisted; do not submit a second deployment.' }, origin)
        }
        if (broadcast?.result !== true) {
          const message = String(broadcast?.message || broadcast?.code || 'NODE_REJECTED_BROADCAST').slice(0,180)
          await db.query(
            "UPDATE public.tron_transfer_deployments SET failure_code=$2,updated_at=now() WHERE operation_id=$1 AND state='broadcast-unknown'",
            [operationId, message],
          ).catch(() => {})
          return send(res, 202, { success: true, deployment: { operationId, state: 'broadcast-unknown', transactionId: unsigned.txID, contractAddress: predictedAddress }, recovery: { available: true, automaticRebroadcast: false }, message: 'Node response did not confirm acceptance. Preserve the transaction ID and reconcile against solidified Mainnet before any further action.' }, origin)
        }
        await db.query(
          "UPDATE public.tron_transfer_deployments SET state='broadcast',broadcast_at=now(),failure_code=NULL,updated_at=now() WHERE operation_id=$1 AND state='broadcast-unknown'",
          [operationId],
        )
        return send(res, 202, { success: true, deployment: { operationId, state: 'broadcast', transactionId: unsigned.txID, contractAddress: predictedAddress }, recovery: { available: true, automaticRebroadcast: false }, message: 'Mainnet accepted the original transaction. Solidified receipt and runtime verification are still pending.' }, origin)
      } catch (error) {
        await db.query(
          "UPDATE public.tron_transfer_deployments SET state='failed',failure_code=$2,updated_at=now() WHERE operation_id=$1 AND state='confirming'",
          [operationId, String(error?.code || 'TRAX_DEPLOYMENT_CONFIRMATION_FAILED').slice(0,120)],
        ).catch(() => {})
        const status = Number.isInteger(error?.status) ? error.status : 503
        return send(res, status, { error: error?.code || 'TRAX_DEPLOYMENT_CONFIRMATION_FAILED', message: String(error?.message || 'Deployment confirmation failed').slice(0,240) }, origin)
      }
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
    const prior = await db.query(
      'SELECT operation_id,state,transaction_id,intent,intent_sha256 FROM public.tron_transfer_deployments WHERE owner_address=$1 AND idempotency_key=$2',
      [session.address, idempotencyKey],
    )
    if (prior.rows?.[0]) {
      const row = prior.rows[0]
      if (row.intent?.artifactSha256 !== artifact.artifactSha256 || row.intent?.feeLimitSun !== feeLimitSun
        || row.intent?.ownerAddress !== session.address) fail('TRAX_DEPLOYMENT_IDEMPOTENCY_CONFLICT', 409)
      return send(res, 200, { success: true, replay: true, deployment: row }, origin)
    }
    try {
      const artifactNow = await artifactLoader({ env })
      const tronWeb = tronWebFactory({ fullHost: mainnetHost(env) })
      tronWeb.fullNode.headers = env.TATUM_API_KEY && String(env.TATUM_TRON_NETWORK || 'mainnet').toLowerCase() === 'mainnet'
        ? { 'x-api-key': String(env.TATUM_API_KEY).trim() }
        : (env.TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': String(env.TRONGRID_API_KEY).trim() } : {})
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
        getMainnetNativeBalance(tronWeb, session.address),
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
      const inserted = await db.query(`
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
        const existing = await db.query(
          'SELECT operation_id,state,transaction_id,intent_sha256 FROM public.tron_transfer_deployments WHERE owner_address=$1 AND idempotency_key=$2',
          [session.address, idempotencyKey],
        )
        const row = existing.rows?.[0]
        if (!row || row.intent?.artifactSha256 !== artifactNow.artifactSha256 || row.intent?.feeLimitSun !== feeLimitSun || row.intent?.ownerAddress !== session.address) fail('TRAX_DEPLOYMENT_IDEMPOTENCY_CONFLICT', 409)
        return send(res, 200, { success: true, replay: true, deployment: row }, origin)
      }
      return send(res, 201, {
        success: true, replay: false, deployment: inserted.rows[0],
        intent, intentSha256, preflight: { estimate, resources: resource, ownerBalanceSun: balanceSun, budget },
        confirmationPhrase: 'CONFIRM TRӾ MAINNET DEPLOYMENT',
        operationId: inserted.rows[0].operation_id,
        message: 'Unsigned deployment transaction and exact artifact fingerprints are durably recorded. No signature or broadcast was requested.',
      }, origin)
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 503
      return send(res, status, { error: error?.code || 'TRAX_DEPLOYMENT_PREPARATION_FAILED', message: String(error?.message || 'TRӾ deployment preparation failed').slice(0, 260) }, origin)
    }
  }
  return Object.freeze({ handle })
}
