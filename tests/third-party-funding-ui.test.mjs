import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

async function read(path) {
  return readFile(new URL('../' + path, import.meta.url), 'utf8')
}

test('owner sponsor navigation opens the direct sponsor workflow inside the unlocked local wallet', async () => {
  const vault = await read('src/WalletVault.tsx')
  const sponsor = await read('src/DirectSponsorPayouts.tsx')
  const index = await read('server/index.mjs')
  assert.ok(vault.includes("function navigatePanel(panel:"))
  assert.ok(vault.includes("onClick={() => navigatePanel('treasury')}"))
  assert.ok(vault.includes('<DirectSponsorPayouts'))
  assert.ok(vault.includes('walletAddress={unlocked.record.address}'))
  assert.ok(vault.includes('privateKey={unlocked.privateKey}'))
  assert.ok(!vault.includes("window.location.hash = '#/workspace'"))
  assert.ok(!vault.includes('Fireblocks treasury setup'))
  assert.ok(!vault.includes('Copy placeholder-only environment template'))
  assert.ok(sponsor.includes('/sponsorship/mainnet-direct/requests'))
  assert.ok(sponsor.includes('/sponsorship/mainnet-direct/review-queue'))
  assert.ok(sponsor.includes("const signer = new TronWeb"))
  assert.ok(index.includes('mainnetDirectSponsorRequestRoutes'))
  assert.ok(index.includes('mainnetDirectSponsorReadinessRoutes'))
  assert.ok(!index.includes('createThirdPartyFundingRouter'))
  assert.ok(!index.includes('createFireblocksDiscoveryRouter'))
})

test('sponsor approval uses local wallet message signatures and never uploads private keys', async () => {
  const sponsor = await read('src/DirectSponsorPayouts.tsx')
  const approval = await read('server/routes/mainnet-direct-sponsor-approval.mjs')
  assert.ok(sponsor.includes('signMessageV2'))
  assert.ok(sponsor.includes('/api/auth/tron/verify'))
  assert.ok(sponsor.includes('body: { nonce: activeChallenge.nonce, signature }'))
  assert.ok(sponsor.includes('This is an approval') || sponsor.includes('An approval message is not a transaction signature.'))
  assert.ok(sponsor.includes('fetch(baseUrl + path'))
  assert.ok(sponsor.includes('JSON.stringify(options.body)'))
  assert.ok(sponsor.includes("new TronWeb({ fullHost: MAINNET_RPC, privateKey: privateKey.replace"))
  assert.ok(!sponsor.includes('body: { privateKey'))
  assert.ok(!sponsor.includes('JSON.stringify({ privateKey'))
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
  const sponsor = await read('src/DirectSponsorPayouts.tsx')
  const readiness = await read('server/routes/mainnet-direct-sponsor-readiness.mjs')
  const approval = await read('server/routes/mainnet-direct-sponsor-approval.mjs')
  assert.ok(sponsor.includes('Your wallet signs one short identity challenge. It does not approve a transfer'))
  assert.ok(sponsor.includes('Budget reserved'))
  assert.ok(sponsor.includes('TRON transaction broadcast'))
  assert.ok(readiness.includes('canSubmitSponsoredTransfer: false'))
  assert.ok(approval.includes('canSubmitSponsoredTransfer: false'))
  assert.ok(approval.includes('transactionBroadcast: false'))
})
