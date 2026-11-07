import { pathToFileURL } from 'node:url'
import path from 'node:path'

export function normalizeNileNodeUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'nile.trongrid.io'
    || url.port || url.username || url.password || (url.pathname !== '/' && url.pathname !== '')
    || url.search || url.hash) {
    throw new TypeError('Testnet verification requires the exact HTTPS Nile TRON node origin')
  }
  return url.origin
}

export async function runSponsorGovernanceTestnetCheck({
  nodeUrl,
  fetchImpl = globalThis.fetch,
  timeoutMs = 12000,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('Fetch implementation is required')
  const origin = normalizeNileNodeUrl(nodeUrl)
  const response = await fetchImpl(new URL('/wallet/getnowblock', origin), {
    method: 'GET',
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error('Nile read-only node request failed')
  const body = await response.json()
  const height = Number(body?.block_header?.raw_data?.number)
  if (!Number.isSafeInteger(height) || height < 1) throw new Error('Nile node returned an invalid block height')
  return {
    network: 'nile',
    nodeReachable: true,
    latestBlockHeight: height,
    requestMethod: 'GET',
    transactionSigned: false,
    transactionBroadcast: false,
    mainnetContacted: false,
    realPayoutExecutionEnabled: false,
  }
}

async function main() {
  if (process.env.SPONSOR_GOVERNANCE_VERIFICATION_NETWORK !== 'nile') {
    throw new Error('Set SPONSOR_GOVERNANCE_VERIFICATION_NETWORK=nile explicitly')
  }
  const report = await runSponsorGovernanceTestnetCheck({
    nodeUrl: process.env.SPONSOR_GOVERNANCE_TESTNET_NODE_URL,
  })
  console.log(JSON.stringify(report, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error('Sponsor governance testnet-only check failed closed. No transaction was signed or broadcast.')
    process.exitCode = 1
  })
}
