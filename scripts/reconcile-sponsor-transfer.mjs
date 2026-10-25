#!/usr/bin/env node
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_API_BASE_URL = 'https://trc20-usdt-token-cloner-api.onrender.com'
const KEY_PATTERN = /^[A-Za-z0-9._:-]{24,160}$/

function safeBaseUrl(value) {
  let url
  try { url = new URL(value) } catch { return null }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
    || url.username || url.password || url.search || url.hash) return null
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url
}

/** Call only the stored-intent reconciliation API; never supplies a txid or costs. */
export async function requestSponsorReconciliation({
  apiBaseUrl = DEFAULT_API_BASE_URL,
  adminToken = process.env.SPONSOR_ADMIN_API_TOKEN,
  idempotencyKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20000,
} = {}) {
  const base = typeof apiBaseUrl === 'string' ? safeBaseUrl(apiBaseUrl) : null
  if (!base) return { ok: false, error: 'invalid-api-base-url' }
  if (typeof adminToken !== 'string' || adminToken.length < 32) {
    return { ok: false, error: 'SPONSOR_ADMIN_API_TOKEN-missing-or-too-short' }
  }
  if (typeof idempotencyKey !== 'string' || !KEY_PATTERN.test(idempotencyKey)) {
    return { ok: false, error: 'invalid-idempotency-key' }
  }
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch-unavailable' }

  try {
    const response = await fetchImpl(
      base.origin + base.pathname + '/api/tron/sponsorship/transfers/' + encodeURIComponent(idempotencyKey) + '/reconcile-solidified',
      {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: 'Bearer ' + adminToken },
        body: '{}',
        signal: AbortSignal.timeout(timeoutMs),
      },
    )
    const payload = await response.json().catch(() => null)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, httpStatus: response.status, error: 'invalid-api-response' }
    }
    return { ok: response.ok && payload.success === true, httpStatus: response.status, payload }
  } catch {
    return { ok: false, error: 'reconciliation-request-failed' }
  }
}

function safePrintableResult(result) {
  const p = result.payload || {}
  return {
    ok: result.ok,
    ...(Number.isInteger(result.httpStatus) ? { httpStatus: result.httpStatus } : {}),
    ...(typeof p.status === 'string' ? { status: p.status } : {}),
    ...(typeof p.error === 'string' ? { error: p.error } : {}),
    ...(typeof p.message === 'string' ? { message: p.message } : {}),
    ...(typeof p.network === 'string' ? { network: p.network } : {}),
    ...(typeof p.asset === 'string' ? { asset: p.asset } : {}),
    ...(typeof p.transactionHash === 'string' ? { transactionHash: p.transactionHash } : {}),
    ...(Number.isSafeInteger(p.blockNumber) ? { blockNumber: p.blockNumber } : {}),
    ...(p.principalLedger && typeof p.principalLedger === 'object' ? { principalLedger: p.principalLedger } : {}),
    ...(p.chainCostObservation && typeof p.chainCostObservation === 'object' ? { chainCostObservation: p.chainCostObservation } : {}),
    ...(p.feeSponsorBudgetSettled === false ? { feeSponsorBudgetSettled: false } : {}),
    ...(p.userFundedFallbackAllowed === false ? { userFundedFallbackAllowed: false } : {}),
    ...(typeof p.note === 'string' ? { note: p.note } : {}),
  }
}

export async function main(argv = process.argv, env = process.env, stdout = process.stdout, stderr = process.stderr) {
  const key = argv[2]
  const result = await requestSponsorReconciliation({
    apiBaseUrl: env.SPONSOR_API_BASE_URL || DEFAULT_API_BASE_URL,
    adminToken: env.SPONSOR_ADMIN_API_TOKEN,
    idempotencyKey: key,
  })
  stdout.write(JSON.stringify(safePrintableResult(result), null, 2) + '\n')
  if (!result.ok) stderr.write('Reconciliation did not complete. Do not submit a replacement transaction; retry the same stored idempotency key after resolving the reported error.\n')
  process.exitCode = result.ok || result.httpStatus === 202 ? 0 : 1
  return result
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main()
}
