import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

async function read(path) {
  return readFile(new URL('../' + path, import.meta.url), 'utf8')
}

test('owner sponsor navigation opens the direct sponsor workflow, not a managed-vault page', async () => {
  const vault = await read('src/WalletVault.tsx')
  const workflow = await read('src/WorkflowApp.tsx')
  const index = await read('server/index.mjs')
  assert.ok(vault.includes("window.location.hash = '#/workspace'"))
  assert.ok(workflow.includes('/sponsorship/mainnet-direct/requests'))
  assert.ok(workflow.includes('/sponsorship/mainnet-direct/review-queue'))
  assert.ok(!vault.includes("import ThirdPartyFundingPanel from"))
  assert.ok(index.includes('mainnetDirectSponsorRequestRoutes'))
  assert.ok(!index.includes('createThirdPartyFundingRouter'))
  assert.ok(!index.includes('createFireblocksDiscoveryRouter'))
})

test('sponsor approval uses wallet signatures and never asks for a sponsor private key', async () => {
  const workflow = await read('src/WorkflowApp.tsx')
  const approval = await read('server/routes/mainnet-direct-sponsor-approval.mjs')
  assert.ok(workflow.includes('signMessageV2'))
  assert.ok(workflow.includes('No private keys or recovery phrases'))
  assert.ok(workflow.includes('This is a sponsor approval statement only, not a TRON transaction'))
  assert.ok(!workflow.includes('id="sponsor-private-key"'))
  assert.ok(approval.includes('verifySponsorMessage'))
  assert.ok(approval.includes('challengeConsumed: true'))
})

test('Mainnet sponsor wallet sessions are bound to a trusted origin and short-lived wallet identity', async () => {
  const approval = await read('server/routes/mainnet-direct-sponsor-approval.mjs')
  assert.ok(approval.includes('if (!token || !origin)'))
  assert.ok(approval.includes('origin,'))
  assert.ok(approval.includes("session.network !== 'mainnet'"))
  assert.ok(approval.includes('session.expiresAt <= now()'))
  assert.ok(approval.includes('challenge.consumed'))
})

test('public addresses do not authorize sponsor spending and approvals do not enable payout execution', async () => {
  const workflow = await read('src/WorkflowApp.tsx')
  const approval = await read('server/routes/mainnet-direct-sponsor-approval.mjs')
  assert.ok(workflow.includes('A configured address is not proof of funds, sponsor authorization'))
  assert.ok(workflow.includes('Sponsor funds reserved: no'))
  assert.ok(workflow.includes('Transaction signature: none'))
  assert.ok(workflow.includes('TRON broadcast: no'))
  assert.ok(approval.includes('onChainBalanceRead !== true'))
  assert.ok(approval.includes('official-mainnet-usdt-sponsor-balance-does-not-cover-request'))
  assert.ok(!approval.includes('canSubmitSponsoredTransfer: true'))
  assert.ok(approval.includes('canSubmitSponsoredTransfer: false'))
})
