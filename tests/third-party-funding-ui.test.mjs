import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

async function read(path) {
  return readFile(new URL('../' + path, import.meta.url), 'utf8')
}

test('third-party funding panel is mounted in the Fireblocks owner treasury screen', async () => {
  const vault = await read('src/WalletVault.tsx')
  const panel = await read('src/ThirdPartyFundingPanel.tsx')
  assert.match(vault, /import ThirdPartyFundingPanel from '\.\/ThirdPartyFundingPanel'/)
  assert.match(vault, /<ThirdPartyFundingPanel[\s\S]*sessionToken=\{ownerSessionToken\}/)
  assert.match(vault, /inventoryVerified=\{fireblocksInventorySnapshot\?\.verificationStatus === 'verified'\}/)
  assert.match(panel, /\/api\/treasury\/third-party-funding/)
  assert.match(panel, /Verify signed consent & register/)
  assert.match(panel, /Verify incoming chain deposit/)
  assert.match(panel, /Reconcile latest Fireblocks inventory/)
  assert.match(panel, /Revoke this funding authorization/)
})

test('funding panel never asks for or accepts a third-party wallet private key', async () => {
  const panel = await read('src/ThirdPartyFundingPanel.tsx')
  assert.doesNotMatch(panel, /name=["']privateKey["']/i)
  assert.doesNotMatch(panel, /id=["'][^"']*private-key[^"']*["']/i)
  assert.doesNotMatch(panel, /type=["']password["']/i)
  assert.match(panel, /never asks for private keys, recovery phrases, wallet passwords, or Fireblocks credentials/i)
})

test('owner treasury refresh uses the signed wallet-auth session for funding and Fireblocks APIs', async () => {
  const vault = await read('src/WalletVault.tsx')
  assert.match(vault, /const signature = await signer\.trx\.signMessageV2\(challenge\.message\)/)
  assert.match(vault, /setOwnerSessionToken\(verified\.sessionToken\)/)
  assert.match(vault, /useEffect\(\(\) => \{[\s\S]*ownerSessionToken[\s\S]*\/api\/treasury\/fireblocks\/inventory\/latest[\s\S]*\}, \[ownerSessionToken\]\)/)
  assert.doesNotMatch(vault, /\/api\/auth\/owner\/session[\s\S]*\/api\/treasury\/fireblocks\/inventory\/latest/)
})

test('funding UI distinguishes an unverified source from a registered consent and stale inventory', async () => {
  const panel = await read('src/ThirdPartyFundingPanel.tsx')
  assert.match(panel, /No source authorized/)
  assert.match(panel, /A public address or watch-only balance is not permission to use funds/)
  assert.match(panel, /const inventoryFresh = inventoryVerified/)
  assert.match(panel, /six-hour maximum/)
  assert.match(panel, /This is not payout authorization/i)
})
