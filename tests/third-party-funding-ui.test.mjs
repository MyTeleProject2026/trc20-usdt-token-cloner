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
  assert.match(vault, /function navigatePanel\\(panel:[\\s\\S]*?window\\.location\\.hash = '#\\/workspace'/)
  assert.match(workflow, /mainnet-direct\\/requests/)
  assert.match(workflow, /mainnet-direct\\/review-queue/)
  assert.doesNotMatch(vault, /import ThirdPartyFundingPanel from/)
  assert.match(index, /mainnetDirectSponsorRequestRoutes/)
  assert.doesNotMatch(index, /createThirdPartyFundingRouter|fireblocks.*Routes|treasury-withdrawals/)
})

test('sponsor approval uses wallet signatures and never asks for a sponsor private key', async () => {
  const workflow = await read('src/WorkflowApp.tsx')
  const approval = await read('server/routes/mainnet-direct-sponsor-approval.mjs')
  assert.match(workflow, /signMessageV2/)
  assert.match(workflow, /No private keys or recovery phrases/)
  assert.match(workflow, /This is a sponsor approval statement only, not a TRON transaction/)
  assert.doesNotMatch(workflow, /id=["']sponsor-private-key["']/i)
  assert.match(approval, /verifySponsorMessage/)
  assert.match(approval, /challengeConsumed: true/)
})

test('Mainnet sponsor wallet sessions are bound to a trusted origin and short-lived wallet identity', async () => {
  const approval = await read('server/routes/mainnet-direct-sponsor-approval.mjs')
  assert.match(approval, /if \\(!token \\|\\| !origin\\)/)
  assert.match(approval, /origin,/)
  assert.match(approval, /session\\.network !== 'mainnet'/)
  assert.match(approval, /session\\.expiresAt <= now\\(\\)/)
  assert.match(approval, /challenge\\.consumed/)
})

test('public addresses do not authorize sponsor spending and approvals do not enable payout execution', async () => {
  const workflow = await read('src/WorkflowApp.tsx')
  const approval = await read('server/routes/mainnet-direct-sponsor-approval.mjs')
  assert.match(workflow, /A configured address is not proof of funds, sponsor authorization/)
  assert.match(workflow, /Sponsor funds reserved: no/)
  assert.match(workflow, /Transaction signature: none/)
  assert.match(workflow, /TRON broadcast: no/)
  assert.match(approval, /onChainBalanceRead !== true/)
  assert.match(approval, /official-mainnet-usdt-sponsor-balance-does-not-cover-request/)
  assert.doesNotMatch(approval, /canSubmitSponsoredTransfer:\\s*true/)
  assert.match(approval, /canSubmitSponsoredTransfer: false/)
})
