import { TronWeb } from 'tronweb'
import { assessTronAccountPermissions } from './tron-account-permission-assessment.mjs'

/**
 * Read-only public TRON chain adapter.
 *
 * Uses the official java-tron HTTP API via the TronGrid public node endpoint.
 * It never creates, signs, broadcasts, or funds transactions. Public API access
 * supplies chain data, not TRX principal or network-fee sponsorship.
 */
const DEFAULT_ORIGIN = 'https://api.trongrid.io'
const ALLOWED_ORIGINS = new Set([DEFAULT_ORIGIN])
const ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const TXID_RE = /^[0-9a-fA-F]{64}$/

function resolveOrigin(value = DEFAULT_ORIGIN) {
  let url
  try { url = new URL(value) } catch { throw new Error('Invalid TRON public API origin') }
  if (url.protocol !== 'https:' || !ALLOWED_ORIGINS.has(url.origin) || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('TRON public API origin must be the approved HTTPS TronGrid origin')
  }
  return url.origin
}

function assertAddress(address) {
  if (typeof address !== 'string' || !ADDRESS_RE.test(address) || !TronWeb.isAddress(address)) {
    const error = new Error('A valid TRON Base58Check address is required')
    error.status = 400
    throw error
  }
}

function assertSafeSunBalance(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('TRON node balance exceeded JavaScript safe integer precision')
    return String(value)
  }
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return value
  if (value == null) return '0'
  throw new Error('TRON node returned an invalid native balance')
}

function formatSunAsTrx(value) {
  const sun = BigInt(value)
  const whole = sun / 1_000_000n
  const fraction = (sun % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return whole.toString() + (fraction ? '.' + fraction : '')
}

function assertTxid(txid) {
  if (typeof txid !== 'string' || !TXID_RE.test(txid)) {
    const error = new Error('A 64-character transaction ID is required')
    error.status = 400
    throw error
  }
}

async function postNode(path, body, { fetchImpl = globalThis.fetch, apiKey = '', origin = DEFAULT_ORIGIN } = {}) {
  const base = resolveOrigin(origin)
  if (typeof fetchImpl !== 'function') throw new Error('Fetch implementation is unavailable')
  const headers = { 'content-type': 'application/json', accept: 'application/json' }
  if (apiKey) headers['TRON-PRO-API-KEY'] = apiKey
  const response = await fetchImpl(base + path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  })
  if (!response.ok) {
    const error = new Error('TRON public API request failed')
    error.status = 502
    error.providerStatus = response.status
    throw error
  }
  const data = await response.json()
  if (data?.Error || data?.error) {
    const error = new Error('TRON node returned an API error')
    error.status = 502
    throw error
  }
  return data
}

export function createPublicTronReadClient(options = {}) {
  const origin = resolveOrigin(options.origin || DEFAULT_ORIGIN)
  const common = { ...options, origin }
  return Object.freeze({
    async getSolidifiedAccount(address) {
      assertAddress(address)
      const account = await postNode('/walletsolidity/getaccount', { address, visible: true }, common)
      const balanceSun = assertSafeSunBalance(account?.balance)
      const permissionAssessment = assessTronAccountPermissions(account)
      return Object.freeze({
        address,
        balanceSun,
        balanceTrx: formatSunAsTrx(balanceSun),
        accountExists: Boolean(account?.address),
        permissionAssessment,
        source: 'tron-solidified-node',
        balanceKind: 'native-trx-account-balance',
        singleSignerCanMoveNativeTrx: permissionAssessment.available
          ? permissionAssessment.singleSignerCanMoveNativeTrx
          : null,
        restrictedEscrowBalance: null,
        note: 'This is the actual native TRX balance of the address from solidified TRON state. Whether one key can move it depends on the account permission thresholds. It is not a smart-contract escrow position.',
      })
    },
    async getAccountResources(address) {
      assertAddress(address)
      const data = await postNode('/wallet/getaccountresource', { address, visible: true }, common)
      return Object.freeze({
        freeBandwidthRemaining: Math.max(0, Number(data?.freeNetLimit || 0) - Number(data?.freeNetUsed || 0)),
        stakedBandwidthRemaining: Math.max(0, Number(data?.NetLimit || 0) - Number(data?.NetUsed || 0)),
        energyRemaining: Math.max(0, Number(data?.EnergyLimit || 0) - Number(data?.EnergyUsed || 0)),
        source: 'tron-full-node-current-resource-state',
      })
    },
    async getContractRuntimeCode(address) {
      assertAddress(address)
      const info = await postNode('/wallet/getcontractinfo', { value: address, visible: true }, common)
      const runtimeCode = String(info?.runtimecode || '').replace(/^0x/i, '').toLowerCase()
      if (!runtimeCode || !/^(?:[0-9a-f]{2})+$/i.test(runtimeCode)) {
        const error = new Error('TRON node did not return contract runtime bytecode')
        error.status = 404
        throw error
      }
      return Object.freeze({
        address,
        runtimeCode,
        providerCodeHash: String(info?.smart_contract?.code_hash || '').replace(/^0x/i, '').toLowerCase() || null,
        source: 'tron-fullnode-contract-info',
      })
    },
    async triggerSolidifiedConstantContract({ contractAddress, functionSelector, parameter = '', ownerAddress }) {
      assertAddress(contractAddress)
      assertAddress(ownerAddress)
      if (typeof functionSelector !== 'string' || !/^[A-Za-z0-9_]+\([^)]*\)$/.test(functionSelector)) {
        const error = new Error('A valid constant contract function selector is required')
        error.status = 400
        throw error
      }
      if (typeof parameter !== 'string' || !/^(?:[0-9a-fA-F]{2})*$/.test(parameter)) {
        const error = new Error('Contract parameters must be even-length ABI hex')
        error.status = 400
        throw error
      }
      const result = await postNode('/walletsolidity/triggerconstantcontract', {
        contract_address: contractAddress,
        function_selector: functionSelector,
        parameter,
        owner_address: ownerAddress,
        visible: true,
      }, common)
      if (result?.result?.result !== true || !Array.isArray(result?.constant_result) || typeof result.constant_result[0] !== 'string') {
        const error = new Error('Solidified contract read did not return a constant result')
        error.status = 502
        throw error
      }
      return Object.freeze({
        resultHex: result.constant_result[0].replace(/^0x/i, ''),
        source: 'tron-solidified-node',
      })
    },
    async getSolidifiedTransaction(txid) {
      assertTxid(txid)
      const [transaction, receipt] = await Promise.all([
        postNode('/walletsolidity/gettransactionbyid', { value: txid }, common),
        postNode('/walletsolidity/gettransactioninfobyid', { value: txid }, common),
      ])
      const found = Boolean(transaction?.txID || transaction?.raw_data)
      return Object.freeze({
        txid,
        found,
        solidifiedReceiptFound: Boolean(receipt?.id || receipt?.blockNumber),
        receipt: receipt && Object.keys(receipt).length ? receipt : null,
        transaction: transaction && Object.keys(transaction).length ? transaction : null,
        source: 'tron-solidified-node',
        finalityNote: 'Verify receipt result and the expected escrow contract event/state before crediting a beneficiary position.',
      })
    },
  })
}
