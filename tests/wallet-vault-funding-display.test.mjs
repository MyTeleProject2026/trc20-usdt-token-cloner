import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8')

test('owner sponsor navigation separates a payout request from real sponsor-funded execution', async () => {
  const vault = await read('src/WalletVault.tsx')
  const workflow = await read('src/WorkflowApp.tsx')
  const requests = await read('server/routes/mainnet-direct-sponsor-requests.mjs')
  const approval = await read('server/routes/mainnet-direct-sponsor-approval.mjs')
  assert.match(vault, /window\\.location\\.hash = '#\\/workspace'/)
  assert.match(workflow, /mainnet-direct\\/requests/)
  assert.match(workflow, /This is a sponsor approval statement only, not a TRON transaction/)
  assert.match(workflow, /Sponsor funds reserved: no/)
  assert.match(workflow, /TRON broadcast: no/)
  assert.match(requests, /canSubmitSponsoredTransfer: false/)
  assert.match(approval, /signingIntentCreated: false/)
  assert.match(approval, /transactionBroadcast: false/)
  assert.doesNotMatch(workflow, /Currently withdrawable now/)
})

test('Mainnet sponsor readiness refreshes automatically and when the workspace regains focus', async () => {
  const workflow = await read('src/WorkflowApp.tsx')
  assert.match(workflow, /loadMainnetDirectSponsorReadiness\\(\\)/)
  assert.match(workflow, /setInterval\\(refreshWhenVisible, 30_000\\)/)
  assert.match(workflow, /window\\.addEventListener\\('focus', refreshWhenVisible\\)/)
  assert.match(workflow, /document\\.addEventListener\\('visibilitychange', refreshWhenVisible\\)/)
  assert.match(workflow, /window\\.removeEventListener\\('focus', refreshWhenVisible\\)/)
  assert.match(workflow, /document\\.removeEventListener\\('visibilitychange', refreshWhenVisible\\)/)
  assert.match(workflow, /requestInFlight \\|\\| cancelled/)
  assert.match(workflow, /mainnet-direct\\/readiness\\?refresh=1/)
})

test('Mainnet sponsor diagnostics remain read-only and cannot imply that a planning target is available funds', async () => {
  const workflow = await read('src/WorkflowApp.tsx')
  const approval = await read('server/routes/mainnet-direct-sponsor-approval.mjs')
  assert.match(workflow, /readOnly\\?: boolean/)
  assert.match(workflow, /mainnetExecutionDisabled\\?: boolean/)
  assert.match(approval, /canCreateSigningIntent: false/)
  assert.match(approval, /canSubmitSponsoredTransfer: false/)
  assert.match(approval, /transactionBroadcast: false/)
  assert.doesNotMatch(approval, /canSubmitSponsoredTransfer:\\s*true/)
})
