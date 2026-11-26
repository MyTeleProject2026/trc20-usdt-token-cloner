import test from 'node:test'
import assert from 'node:assert/strict'
import { runLocalSignerAcceptance } from '../src/lib/local-signer-acceptance.mjs'

const address = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const signature = 'cd'.repeat(65)

test('local signer acceptance requests a role-bound challenge and sends only the signature', async () => {
  const calls = []
  const authClient = {
    async apiRequest(path, options = {}) {
      calls.push({ path, options })
      if (path.endsWith('/verify')) return {
        success: true, verified: true, role: 'owner', address,
        verifiedAt: '2026-11-26T02:20:00.000Z',
        transactionCreated: false, broadcast: false, signatureStored: false, privateKeyReceived: false,
      }
      return { success: true, challengeId: 'challenge-1', message: 'TRON Mainnet challenge' }
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
  assert.equal(calls[0].path, '/api/wallet-auth/owner/signing-challenge')
  assert.equal(calls[1].path, '/api/wallet-auth/owner/signing-challenge/verify')
  assert.equal(calls[1].options.method, 'POST')
  assert.equal(calls[1].options.csrf, true)
  assert.deepEqual(Object.keys(calls[1].options.body).sort(), ['challengeId','signature'])
})

test('local signer acceptance rejects mismatched local vault addresses before requesting a challenge', async () => {
  let requests = 0
  await assert.rejects(() => runLocalSignerAcceptance({
    authClient: { apiRequest: async () => { requests += 1; return {} } },
    tronWeb: { isAddress: () => true, defaultAddress: { base58: 'TWrong' }, address: { toHex: value => value } },
    address, role: 'owner',
  }), /LOCAL_SIGNER_ADDRESS_MISMATCH/)
  assert.equal(requests, 0)
})
