import test from 'node:test'
import assert from 'node:assert/strict'
import { runLocalSignerAcceptance } from '../src/lib/local-signer-acceptance.mjs'

const address = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const signature = 'cd'.repeat(65)

test('local signer acceptance requests a role-bound challenge and sends only the signature', async () => {
  const calls = []
  const authClient = {
    async signingChallenge() {
      calls.push({ method: 'GET' })
      return { success: true, role: 'owner', challengeId: 'challenge-1', message: 'TRON Mainnet challenge Address: ' + address }
    },
    async verifySigningChallenge(challengeId, signed) {
      calls.push({ method: 'POST', challengeId, signed })
      return {
        success: true, verified: true, role: 'owner', address,
        verifiedAt: '2026-11-26T02:20:00.000Z',
        transactionCreated: false, broadcast: false, signatureStored: false, privateKeyReceived: false,
      }
    },
  }
  const tronWeb = {
    defaultAddress: { base58: address },
    isAddress: value => value === address,
    address: { toHex: value => value === address ? '41' + '11'.repeat(20) : '' },
    trx: { signMessageV2: async message => { assert.equal(message, 'TRON Mainnet challenge'); return signature } },
  }
  const result = await runLocalSignerAcceptance({ authClient, tronWeb, address, role: 'owner' })
  assert.equal(result.verified, true)
  assert.equal(result.broadcast, false)
  assert.equal('signature' in result, false)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls, [
    { method: 'GET' },
    { method: 'POST', challengeId: 'challenge-1', signed: signature },
  ])
})

test('local signer acceptance rejects mismatched local vault addresses before requesting a challenge', async () => {
  let requests = 0
  await assert.rejects(() => runLocalSignerAcceptance({
    authClient: { signingChallenge: async () => { requests += 1; return {} }, verifySigningChallenge: async () => ({}) },
    tronWeb: { isAddress: () => true, defaultAddress: { base58: 'TWrong' }, address: { toHex: value => value } },
    address, role: 'owner',
  }), /LOCAL_SIGNER_ADDRESS_MISMATCH/)
  assert.equal(requests, 0)
})


test('Owner and Sponsor workspaces expose separate sign-only acceptance actions', async () => {
  const { readFile } = await import('node:fs/promises')
  const owner = await readFile(new URL('../src/TRXMainnetPanel.jsx', import.meta.url), 'utf8')
  const sponsor = await readFile(new URL('../src/SponsorWalletManager.jsx', import.meta.url), 'utf8')
  assert.match(owner, /role: 'owner'/)
  assert.match(sponsor, /role: 'sponsor'/)
  assert.match(owner, /Run sign-only acceptance/)
  assert.match(sponsor, /Run sign-only acceptance/)
  assert.match(owner, /No transaction, fee or broadcast occurred/)
  assert.match(sponsor, /no transaction is created or broadcast/i)
})
