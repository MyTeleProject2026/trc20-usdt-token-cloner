import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8')

test('owner sponsor navigation separates a payout request from real sponsor-funded execution', async () => {
  const vault = await read('src/WalletVault.tsx')
  const workflow = await read('src/WorkflowApp.tsx')
  const requests = await read('server/routes/mainnet-direct-sponsor-requests.mjs')
  const approval = await read('server/routes/mainnet-direct-sponsor-approval.mjs')
  assert.ok(vault.includes("window.location.hash = '#/workspace'"))
  assert.ok(workflow.includes('/sponsorship/mainnet-direct/requests'))
  assert.ok(workflow.includes('This is a sponsor approval statement only, not a TRON transaction'))
  assert.ok(workflow.includes('Sponsor funds reserved: no'))
  assert.ok(workflow.includes('TRON broadcast: no'))
  assert.ok(requests.includes('canSubmitSponsoredTransfer: false'))
  assert.ok(approval.includes('signingIntentCreated: false'))
  assert.ok(approval.includes('transactionBroadcast: false'))
  assert.ok(!workflow.includes('Currently withdrawable now'))
})

test('Mainnet sponsor readiness refreshes automatically and when the workspace regains focus', async () => {
  const workflow = await read('src/WorkflowApp.tsx')
  assert.ok(workflow.includes('loadMainnetDirectSponsorReadiness()'))
  assert.ok(workflow.includes('setInterval(refreshWhenVisible, 30_000)'))
  assert.ok(workflow.includes("window.addEventListener('focus', refreshWhenVisible)"))
  assert.ok(workflow.includes("document.addEventListener('visibilitychange', refreshWhenVisible)"))
  assert.ok(workflow.includes("window.removeEventListener('focus', refreshWhenVisible)"))
  assert.ok(workflow.includes("document.removeEventListener('visibilitychange', refreshWhenVisible)"))
  assert.ok(workflow.includes('requestInFlight || cancelled'))
  assert.ok(workflow.includes('/api/tron/sponsorship/mainnet-direct/readiness?refresh=1'))
})

test('Mainnet sponsor diagnostics remain read-only and cannot imply that a planning target is available funds', async () => {
  const workflow = await read('src/WorkflowApp.tsx')
  const approval = await read('server/routes/mainnet-direct-sponsor-approval.mjs')
  assert.ok(workflow.includes('readOnly?: boolean'))
  assert.ok(workflow.includes('mainnetExecutionDisabled?: boolean'))
  assert.ok(approval.includes('canCreateSigningIntent: false'))
  assert.ok(approval.includes('canSubmitSponsoredTransfer: false'))
  assert.ok(approval.includes('transactionBroadcast: false'))
  assert.ok(!approval.includes('canSubmitSponsoredTransfer: true'))
})
