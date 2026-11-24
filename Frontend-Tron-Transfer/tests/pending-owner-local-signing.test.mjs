import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('pending-owner acceptance uses an ephemeral local signer and no injected wallet provider', async () => {
  const source = await readFile(new URL('../src/PendingOwnerAcceptance.jsx', import.meta.url), 'utf8')
  assert.match(source, /deriveOwnerAccount/)
  assert.match(source, /createOwnerTronWeb\(account\.privateKey\)/)
  assert.match(source, /signer\.trx\.signMessageV2\(challenge\.message\)/)
  assert.match(source, /signer\.trx\.sign\(prepared\.unsignedTransaction\)/)
  assert.match(source, /pendingSigner\.current=null/)
  assert.match(source, /unlockPendingOwnerSigner/)
  assert.match(source, /pendingKeyInput\.current\.value=''/)
  assert.doesNotMatch(source, /window\.tronLink|window\.tronWeb|tron_requestAccounts|TronLink/)
  assert.doesNotMatch(source, /localStorage|sessionStorage/)
  assert.match(source, /not uploaded, saved to local storage, or sent to an external wallet provider/)
})
