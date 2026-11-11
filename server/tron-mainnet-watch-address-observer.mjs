import { isValidTronAddress } from './tron-address.mjs'

export const TRON_MAINNET_WATCH_ONLY_ADDRESSES = Object.freeze([
  'TU3kjFuhtEo42tsCBtfYUAZxoqQ4yuSLQ5',
  'THPvaUhoh2Qn2y9THCZML3H815hhFhn5YC',
])

export const TRON_MAINNET_WATCH_ONLY_USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

const TRONGRID_API = 'https://api.trongrid.io'
const TX_ID_RE = /^[0-9a-f]{64}$/i
const UINT_RE = /^(0|[1-9][0-9]*)$/
const MAX_RESPONSE_BYTES = 256 * 1024
const MAX_EVENTS_PER_ADDRESS = 25
const MAX_VERIFICATIONS_PER_ADDRESS = 12

async function readBoundedJson(response) {
  const contentLength = response.headers?.get?.('content-length')
  if (contentLength && (!UINT_RE.test(contentLength) || Number(contentLength) > MAX_RESPONSE_BYTES)) {
    throw new Error('watch-history-response-too-large')
  }
  const reader = response.body?.getReader?.()
  if (!reader) throw new Error('watch-history-response-invalid')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let body = ''
  let received = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!(value instanceof Uint8Array)) throw new Error('watch-history-response-invalid')
      received += value.byteLength
      if (received > MAX_RESPONSE_BYTES) {
        try { await reader.cancel() } catch {}
        throw new Error('watch-history-response-too-large')
      }
      body += decoder.decode(value, { stream: true })
    }
    body += decoder.decode()
  } catch (error) {
    try { await reader.cancel() } catch {}
    if (error?.message === 'watch-history-response-too-large') throw error
    throw new Error('watch-history-response-invalid')
  } finally {
    try { reader.releaseLock() } catch {}
  }
  try { return JSON.parse(body) } catch { throw new Error('watch-history-response-invalid') }
}

function validCandidate(item, watchedAddress) {
  const transactionHash = typeof item?.transaction_id === 'string' ? item.transaction_id.toLowerCase() : ''
  const from = item?.from
  const to = item?.to
  const amountBaseUnits = String(item?.value ?? '')
  const decimals = Number(item?.token_info?.decimals)
  const blockTimestamp = Number(item?.block_timestamp)
  if (!TX_ID_RE.test(transactionHash) || !isValidTronAddress(from)
    || to !== watchedAddress || from === watchedAddress
    || item?.token_info?.address !== TRON_MAINNET_WATCH_ONLY_USDT_CONTRACT
    || decimals !== 6 || !UINT_RE.test(amountBaseUnits) || amountBaseUnits === '0'
    || !Number.isSafeInteger(blockTimestamp) || blockTimestamp <= 0) return null
  return { transactionHash, from, to, amountBaseUnits, blockTimestamp }
}

/**
 * Reads recent confirmed USDT transfer candidates for two externally controlled
 * or ownership-unverified TRON Mainnet addresses. Every candidate is checked
 * against solidified transaction/receipt evidence before it is marked observed.
 *
 * This observer has no database handle and performs no ledger mutation,
 * balance aggregation, reservation, signing, or transaction broadcast.
 */
export function createTronMainnetWatchAddressObserver({
  env = process.env,
  fetchImpl = globalThis.fetch,
  verifyTransfer,
  now = () => Date.now(),
} = {}) {
  if (typeof fetchImpl !== 'function' || typeof verifyTransfer !== 'function' || typeof now !== 'function') {
    throw new TypeError('watch-address-observer-dependencies-invalid')
  }

  return async function observeTronMainnetWatchAddresses() {
    const checkedAt = new Date(now()).toISOString()
    const apiKey = typeof env.TRONGRID_API_KEY === 'string' ? env.TRONGRID_API_KEY.trim() : ''
    const addresses = []

    for (const address of TRON_MAINNET_WATCH_ONLY_ADDRESSES) {
      const url = new URL('/v1/accounts/' + encodeURIComponent(address) + '/transactions/trc20', TRONGRID_API)
      url.searchParams.set('only_confirmed', 'true')
      url.searchParams.set('limit', String(MAX_EVENTS_PER_ADDRESS))
      url.searchParams.set('contract_address', TRON_MAINNET_WATCH_ONLY_USDT_CONTRACT)
      url.searchParams.set('order_by', 'block_timestamp,desc')
      const headers = { Accept: 'application/json' }
      if (apiKey) headers['TRON-PRO-API-KEY'] = apiKey

      let payload
      try {
        const response = await fetchImpl(url.toString(), {
          method: 'GET',
          headers,
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.timeout(10_000),
        })
        if (!response?.ok) throw new Error('watch-history-provider-unavailable')
        payload = await readBoundedJson(response)
      } catch {
        addresses.push({
          address,
          ownershipStatus: 'not-verified',
          monitoringMode: 'read-only',
          status: 'history-unavailable',
          observations: [],
          error: 'mainnet-history-provider-unavailable',
          spendableBalanceImpact: 'none',
        })
        continue
      }

      if (!Array.isArray(payload?.data) || payload.data.length > MAX_EVENTS_PER_ADDRESS) {
        addresses.push({
          address,
          ownershipStatus: 'not-verified',
          monitoringMode: 'read-only',
          status: 'history-response-invalid',
          observations: [],
          error: 'mainnet-history-response-invalid',
          spendableBalanceImpact: 'none',
        })
        continue
      }

      const candidates = []
      const seen = new Set()
      for (const item of payload.data) {
        const candidate = validCandidate(item, address)
        if (!candidate) continue
        const key = [candidate.transactionHash, candidate.from, candidate.to, candidate.amountBaseUnits].join(':')
        if (seen.has(key)) continue
        seen.add(key)
        candidates.push(candidate)
      }

      const observations = []
      for (const candidate of candidates.slice(0, MAX_VERIFICATIONS_PER_ADDRESS)) {
        let proof
        try {
          proof = await verifyTransfer(env, {
            transactionHash: candidate.transactionHash,
            from: candidate.from,
            to: candidate.to,
            amountBaseUnits: candidate.amountBaseUnits,
          })
        } catch {
          proof = { verified: false, status: 'solidified-provider-unavailable' }
        }
        const exactProof = proof?.verified === true
          && String(proof.transactionHash || proof.txId || '').toLowerCase() === candidate.transactionHash
          && proof.contract === TRON_MAINNET_WATCH_ONLY_USDT_CONTRACT
          && proof.from === candidate.from
          && proof.to === candidate.to
          && String(proof.amountBaseUnits ?? '') === candidate.amountBaseUnits
          && Number.isSafeInteger(Number(proof.blockNumber)) && Number(proof.blockNumber) > 0
          && Number.isSafeInteger(Number(proof.logIndex)) && Number(proof.logIndex) >= 0

        observations.push({
          ...candidate,
          status: exactProof
            ? 'solidified-mainnet-usdt-transfer-observed'
            : proof?.status === 'awaiting-solidified-receipt'
              ? 'awaiting-solidified-receipt'
              : 'not-verified',
          solidifiedBlockNumber: exactProof ? Number(proof.blockNumber) : null,
          eventIndex: exactProof ? Number(proof.logIndex) : null,
          observedOnChain: exactProof,
          ownershipStatus: 'not-verified',
          spendableBalanceImpact: 'none',
        })
      }

      addresses.push({
        address,
        ownershipStatus: 'not-verified',
        monitoringMode: 'read-only',
        status: 'history-observed',
        observations,
        candidateCount: candidates.length,
        verificationLimitReached: candidates.length > MAX_VERIFICATIONS_PER_ADDRESS,
        moreHistoryAvailable: Boolean(payload?.meta?.fingerprint),
        spendableBalanceImpact: 'none',
      })
    }

    return Object.freeze({
      network: 'mainnet',
      tokenContract: TRON_MAINNET_WATCH_ONLY_USDT_CONTRACT,
      decimals: 6,
      checkedAt,
      addresses: Object.freeze(addresses),
      ownershipVerified: false,
      ledgerMutationPerformed: false,
      spendableBalanceImpact: 'none',
      payoutSubmissionEnabled: false,
      limitations: Object.freeze([
        'These addresses are monitored as external or ownership-unverified watch targets.',
        'A solidified transfer observation does not prove address ownership or spending authority.',
        'Observed transfers are excluded from treasury balances, reservations, and withdrawable funds.',
        'The history index is only a candidate source; each reported confirmed event is cross-checked against solidified transaction and receipt evidence.',
        'Only the most recent bounded history page is inspected; this is not a complete historical archive.',
      ]),
    })
  }
}
