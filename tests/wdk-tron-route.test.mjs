import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('WDK route is GET-only, pins Mainnet USDT, and restricts GasFree providers to discovery results', async () => {
  const route = await read('../server/routes/wdk-tron.mjs')
  const service = await read('../server/wdk-tron-readonly.mjs')
  const index = await read('../server/index.mjs')
  assert.match(route, /router\.get\('\/tron\/readiness'/)
  assert.doesNotMatch(route, /router\.post\(/)
  assert.match(route, /tokenAddress !== OFFICIAL_MAINNET_USDT/)
  assert.match(route, /provider\.address === serviceProvider/)
  assert.match(index, /app\.use\('\/api\/wdk', wdkTronRoutes\)/)
  assert.match(service, /WalletAccountReadOnlyTron/)
  assert.match(service, /WalletAccountReadOnlyTronGasfree/)
  assert.doesNotMatch(service, /\.transfer\s*\(|\.sign\s*\(|\.sendTransaction\s*\(/)
})

test('GasFree submission and existing sponsor payout release gates remain closed', async () => {
  const gasfree = await read('../server/routes/gasfree.mjs')
  const sponsor = await read('../server/routes/sponsor-direct-payouts.mjs')
  assert.match(gasfree, /sponsored-submission-disabled/)
  assert.match(gasfree, /submissionEnabled: false/)
  assert.match(sponsor, /tronLink|TronLink|signed_transaction|signedTransaction/i)
  assert.match(sponsor, /verifySponsorDirectMainnetTransfer/)
})
