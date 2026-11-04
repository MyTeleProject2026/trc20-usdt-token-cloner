import { tatumProviderFetch } from './tatum-provider-fetch.mjs'

const NETWORK_ORIGINS = Object.freeze({
  mainnet: 'https://api.trongrid.io',
  nile: 'https://nile.trongrid.io',
  shasta: 'https://api.shasta.trongrid.io',
})
const ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const TXID_RE = /^[0-9a-f]{64}$/i

function clean(value, max = 128) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function normalizeAddress(value, decodeAddress) {
  const candidate = clean(value, 96)
  if (ADDRESS_RE.test(candidate)) return candidate
  const hex = candidate.replace(/^0x/i, '')
  if (!/^(?:41)?[0-9a-f]{40}$/i.test(hex) || typeof decodeAddress !== 'function') return null
  try {
    const decoded = decodeAddress(hex.length === 40 ? '41' + hex : hex)
    return ADDRESS_RE.test(decoded) ? decoded : null
  } catch {
    return null
  }
}

function extractRows(payload) {
  return Array.isArray(payload?.data) ? payload.data : []
}

function normalizeTimestamp(value) {
  const timestamp = Number(value)
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null
}

function normalizeBlock(value) {
  const block = Number(value)
  return Number.isSafeInteger(block) && block > 0 ? block : null
}

export function normalizeTronGridNativeIncoming(payload, recipientAddress, decodeAddress) {
  return extractRows(payload).slice(0, 200).flatMap((row) => {
    const executionResults = Array.isArray(row?.ret) ? row.ret : []
    if (!executionResults.some((item) => item?.contractRet === 'SUCCESS')) return []
    const contracts = Array.isArray(row?.raw_data?.contract) ? row.raw_data.contract : []
    const transfer = contracts.find((entry) => entry?.type === 'TransferContract')
    const value = transfer?.parameter?.value || {}
    const from = normalizeAddress(value.owner_address || row?.from || row?.ownerAddress, decodeAddress)
    const to = normalizeAddress(value.to_address || row?.to || row?.toAddress, decodeAddress)
    const amountRaw = value.amount ?? row?.amount ?? row?.value
    const amount = typeof amountRaw === 'number' && Number.isSafeInteger(amountRaw)
      ? String(amountRaw)
      : clean(amountRaw, 96)
    const txid = clean(row?.txID || row?.txid || row?.transaction_id || row?.hash, 96).toLowerCase()
    if (!TXID_RE.test(txid) || !from || to !== recipientAddress || !/^(0|[1-9][0-9]*)$/.test(amount)) return []
    return [{
      txid, from, to, tokenContract: null, amountBaseUnits: amount,
      asset: 'TRX', symbol: 'TRX', decimals: 6,
      timestamp: normalizeTimestamp(row?.block_timestamp || row?.timestamp),
      blockNumber: normalizeBlock(row?.blockNumber || row?.block_number),
      confirmed: true, direction: 'incoming',
    }]
  })
}

export function normalizeTronGridTrc20Incoming(payload, recipientAddress, decodeAddress, contractFilter = '') {
  return extractRows(payload).slice(0, 200).flatMap((row) => {
    const token = row?.token_info || row?.tokenInfo || {}
    const from = normalizeAddress(row?.from || row?.fromAddress, decodeAddress)
    const to = normalizeAddress(row?.to || row?.toAddress, decodeAddress)
    const tokenContract = normalizeAddress(
      row?.contract_address || row?.contractAddress || token?.address || token?.contractAddress,
      decodeAddress,
    )
    const amount = clean(row?.value || row?.amount || row?.amountBaseUnits, 96)
    const decimals = Number(token?.decimals ?? row?.decimals)
    const txid = clean(row?.transaction_id || row?.txID || row?.txid || row?.hash, 96).toLowerCase()
    if (!TXID_RE.test(txid) || !from || to !== recipientAddress || !tokenContract
      || (contractFilter && tokenContract !== contractFilter)
      || !/^(0|[1-9][0-9]*)$/.test(amount)
      || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return []
    return [{
      txid, from, to, tokenContract, amountBaseUnits: amount,
      asset: 'TRC20', symbol: clean(token?.symbol || row?.symbol || 'TRC20', 24) || 'TRC20',
      decimals, timestamp: normalizeTimestamp(row?.block_timestamp || row?.timestamp),
      blockNumber: normalizeBlock(row?.block_number || row?.blockNumber),
      confirmed: true, direction: 'incoming',
    }]
  })
}

async function requestHistory({ network, address, tokenContract, tokenHistory = false, apiKey, fetchImpl, timeoutMs }) {
  const origin = NETWORK_ORIGINS[network]
  if (!origin) throw new TypeError('Unsupported TRON history network.')
  const query = new URLSearchParams({
    only_confirmed: 'true',
    only_to: 'true',
    limit: '50',
    order_by: 'block_timestamp,desc',
  })
  if (tokenContract) query.set('contract_address', tokenContract)
  const path = tokenHistory
    ? '/v1/accounts/' + encodeURIComponent(address) + '/transactions/trc20'
    : '/v1/accounts/' + encodeURIComponent(address) + '/transactions'
  const headers = { Accept: 'application/json' }
  if (apiKey) headers['TRON-PRO-API-KEY'] = apiKey
  const response = await fetchImpl(origin + path + '?' + query.toString(), {
    method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error('TRON account history request failed.')
    error.status = response.status
    throw error
  }
  if (!payload || !Array.isArray(payload.data)) throw new Error('TRON account history response was invalid.')
  return payload
}

export async function readTronGridIncomingHistory({
  network, address, tokenContract = '', apiKey = '', fetchImpl = tatumProviderFetch,
  decodeAddress, timeoutMs = 12000,
}) {
  if (!NETWORK_ORIGINS[network]) throw new TypeError('Unsupported TRON history network.')
  if (!ADDRESS_RE.test(address)) throw new TypeError('Recipient must be a TRON Base58 address.')
  if (tokenContract && !ADDRESS_RE.test(tokenContract)) throw new TypeError('Token contract must be a TRON Base58 address.')
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function.')

  const [nativeResult, tokenResult] = await Promise.allSettled([
    requestHistory({ network, address, tokenHistory: false, apiKey, fetchImpl, timeoutMs }),
    requestHistory({ network, address, tokenContract, tokenHistory: true, apiKey, fetchImpl, timeoutMs }),
  ])
  const nativeHistoryRead = nativeResult.status === 'fulfilled'
  const tokenHistoryRead = tokenResult.status === 'fulfilled'
  const history = [
    ...(nativeHistoryRead ? normalizeTronGridNativeIncoming(nativeResult.value, address, decodeAddress) : []),
    ...(tokenHistoryRead ? normalizeTronGridTrc20Incoming(tokenResult.value, address, decodeAddress, tokenContract) : []),
  ].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 50)

  return {
    history, nativeHistoryRead, tokenHistoryRead,
    historyStatus: nativeHistoryRead && tokenHistoryRead ? 'complete'
      : nativeHistoryRead || tokenHistoryRead ? 'partial' : 'unavailable',
    providerErrors: {
      ...(nativeHistoryRead ? {} : { native: Number.isInteger(nativeResult.reason?.status) ? 'http-' + nativeResult.reason.status : 'request-failed' }),
      ...(tokenHistoryRead ? {} : { trc20: Number.isInteger(tokenResult.reason?.status) ? 'http-' + tokenResult.reason.status : 'request-failed' }),
    },
  }
}

export const TRONGRID_HISTORY_ORIGINS = NETWORK_ORIGINS
