import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8')

test('owner sponsor navigation uses a separate local-wallet request path and does not imply actual execution', async () => {
  const vault = await read('src/WalletVault.tsx')
  const sponsor = await read('src/DirectSponsorPayouts.tsx')
  const requests = await read('server/routes/mainnet-direct-sponsor-requests.mjs')
  const approval = await read('server/routes/mainnet-direct-sponsor-approval.mjs')
  assert.ok(vault.includes("function navigatePanel(panel:"))
  assert.ok(vault.includes("onClick={() => navigatePanel('treasury')}"))
  assert.ok(vault.includes('<DirectSponsorPayouts'))
  assert.ok(sponsor.includes('/api/tron/sponsorship/mainnet-direct/requests'))
  assert.ok(sponsor.includes('This workflow can store a request and verify request-specific sponsor approval messages.'))
  assert.ok(sponsor.includes('No USDT was reserved, signed or broadcast.'))
  assert.ok(requests.includes('canSubmitSponsoredTransfer: false'))
  assert.ok(approval.includes('signingIntentCreated: false'))
  assert.ok(approval.includes('transactionBroadcast: false'))
})

test('Mainnet sponsor readiness refreshes automatically and on focus and visibility return', async () => {
  const sponsor = await read('src/DirectSponsorPayouts.tsx')
  assert.ok(sponsor.includes('refreshReadiness()'))
  assert.ok(sponsor.includes('setInterval(refreshWhenVisible, 30_000)'))
  assert.ok(sponsor.includes("window.addEventListener('focus', refreshWhenVisible)"))
  assert.ok(sponsor.includes("document.addEventListener('visibilitychange', refreshWhenVisible)"))
  assert.ok(sponsor.includes("window.removeEventListener('focus', refreshWhenVisible)"))
  assert.ok(sponsor.includes("document.removeEventListener('visibilitychange', refreshWhenVisible)"))
  assert.ok(sponsor.includes('if (cancelled || document.visibilityState === \'hidden\' || inFlight) return'))
  assert.ok(sponsor.includes('/api/tron/sponsorship/mainnet-direct/readiness?refresh=1'))
})

test('Mainnet sponsor diagnostics remain read-only and never imply that a planning target is available funds', async () => {
  const sponsor = await read('src/DirectSponsorPayouts.tsx')
  const readiness = await read('server/routes/mainnet-direct-sponsor-readiness.mjs')
  assert.ok(sponsor.includes('readiness.canSubmitSponsoredTransfer'))
  assert.ok(readiness.includes('readOnly: true'))
  assert.ok(readiness.includes('mainnetExecutionDisabled: MAINNET_DIRECT_SPONSOR_EXECUTION_DISABLED'))
  assert.ok(readiness.includes('canCreateSigningIntent: false'))
  assert.ok(readiness.includes('canSubmitSponsoredTransfer: false'))
})
