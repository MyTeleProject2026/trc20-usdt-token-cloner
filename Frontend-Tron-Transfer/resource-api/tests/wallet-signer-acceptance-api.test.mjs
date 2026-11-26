import test from 'node:test'
import assert from 'node:assert/strict'
import { TronWeb } from 'tronweb'
import { createWalletSignerAcceptanceApi } from '../wallet-signer-acceptance-api.mjs'

const owner = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const sponsor = 'TSPz5ULCfd4zbMUCfF337KWyia8F1F5kYR'
const origin = 'https://tron-transfer.onrender.com'
const signature = 'ab'.repeat(65)

function makeRequest(method, headers = {}, body = null) {
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== null) yield Buffer.from(JSON.stringify(body))
    },
  }
}

function makeApi({ recoveredAddress = owner, now = () => 1_800_000_000_000 } = {}) {
  const replies = []
  const api = createWalletSignerAcceptanceApi({
    send: (_res, status, payload) => { replies.push({ status, payload }); return true },
    identityReport: {
      network: 'TRON Mainnet',
      owner: { address: owner },
      sponsor: { address: sponsor },
      identitiesDistinct: true,
    },
    authenticateOwnerSession: async (req, { requireCsrf }) => {
      if (requireCsrf && (req.headers.origin !== origin || req.headers['x-owner-csrf-token'] !== 'owner-csrf')) return null
      return { address: owner, sessionId: 11 }
    },
    authenticateSponsorSession: async (req, { requireCsrf }) => {
      if (requireCsrf && (req.headers.origin !== origin || req.headers['x-csrf-token'] !== 'sponsor-csrf')) return null
      return { address: sponsor, sessionId: 22 }
    },
    tronWebFactory: () => ({
      isAddress: value => value === owner || value === sponsor,
      address: { toHex: value => value === owner ? '41' + '11'.repeat(20) : '41' + '22'.repeat(20) },
      trx: { verifyMessageV2: async (message, signed) => {
        assert.match(message, /Purpose: prove local key control only/)
        assert.equal(signed, signature)
        return recoveredAddress
      } },
    }),
    now,
  })
  const url = role => new URL('https://api.test/api/wallet-auth/' + role + '/signing-challenge')
  return { api, replies, url }
}

test('Owner sign-only challenge is session-bound and verifies locally without a transaction', async () => {
  const { api, replies, url } = makeApi()
  await api.handle(makeRequest('GET'), {}, url('owner'), origin)
  const challenge = replies.pop()
  assert.equal(challenge.status, 200)
  assert.equal(challenge.payload.role, 'owner')
  assert.match(challenge.payload.message, /Network: TRON Mainnet/)
  await api.handle(makeRequest('POST', { origin, 'x-owner-csrf-token': 'owner-csrf' }, {
    challengeId: challenge.payload.challengeId, signature,
  }), {}, new URL(url('owner').href + '/verify'), origin)
  const verified = replies.pop()
  assert.equal(verified.status, 200)
  assert.equal(verified.payload.verified, true)
  assert.equal(verified.payload.address, owner)
  assert.equal(verified.payload.transactionCreated, false)
  assert.equal(verified.payload.broadcast, false)
  assert.equal(verified.payload.signatureStored, false)
  assert.equal(verified.payload.privateKeyReceived, false)
  assert.equal('signature' in verified.payload, false)
  assert.equal(api.pendingChallengeCount(), 0)
})

test('Sponsor sign-only challenge uses the independent Sponsor session and identity', async () => {
  const { api, replies, url } = makeApi({ recoveredAddress: sponsor })
  await api.handle(makeRequest('GET'), {}, url('sponsor'), origin)
  const challenge = replies.pop()
  assert.equal(challenge.status, 200)
  assert.equal(challenge.payload.role, 'sponsor')
  await api.handle(makeRequest('POST', { origin, 'x-csrf-token': 'sponsor-csrf' }, {
    challengeId: challenge.payload.challengeId, signature,
  }), {}, new URL(url('sponsor').href + '/verify'), origin)
  const verified = replies.pop()
  assert.equal(verified.status, 200)
  assert.equal(verified.payload.verified, true)
  assert.equal(verified.payload.address, sponsor)
})

test('sign-only verification rejects missing CSRF, then permits one valid verification and blocks replay', async () => {
  const { api, replies, url } = makeApi()
  await api.handle(makeRequest('GET'), {}, url('owner'), origin)
  const challenge = replies.pop().payload
  await api.handle(makeRequest('POST', { origin }, { challengeId: challenge.challengeId, signature }), {}, new URL(url('owner').href + '/verify'), origin)
  assert.equal(replies.pop().status, 401)
  assert.equal(api.pendingChallengeCount(), 1)
  await api.handle(makeRequest('POST', { origin, 'x-owner-csrf-token': 'owner-csrf' }, { challengeId: challenge.challengeId, signature }), {}, new URL(url('owner').href + '/verify'), origin)
  assert.equal(replies.pop().status, 200)
  assert.equal(api.pendingChallengeCount(), 0)
  await api.handle(makeRequest('POST', { origin, 'x-owner-csrf-token': 'owner-csrf' }, { challengeId: challenge.challengeId, signature }), {}, new URL(url('owner').href + '/verify'), origin)
  assert.equal(replies.pop().status, 409)
})

test('sign-only challenge rejects a signature recovered to the other wallet', async () => {
  const { api, replies, url } = makeApi({ recoveredAddress: sponsor })
  await api.handle(makeRequest('GET'), {}, url('owner'), origin)
  const challenge = replies.pop().payload
  await api.handle(makeRequest('POST', { origin, 'x-owner-csrf-token': 'owner-csrf' }, { challengeId: challenge.challengeId, signature }), {}, new URL(url('owner').href + '/verify'), origin)
  assert.equal(replies.pop().status, 401)
})

test('sign-only challenge expires and cannot be replayed', async () => {
  let time = 1_800_000_000_000
  const { api, replies, url } = makeApi({ now: () => time })
  await api.handle(makeRequest('GET'), {}, url('owner'), origin)
  const challenge = replies.pop().payload
  time += 120_001
  await api.handle(makeRequest('POST', { origin, 'x-owner-csrf-token': 'owner-csrf' }, { challengeId: challenge.challengeId, signature }), {}, new URL(url('owner').href + '/verify'), origin)
  assert.equal(replies.pop().status, 410)
})


test('TRON Web v6 signs and recovers an actual local message signature without RPC broadcast', async () => {
  const ownerTronWeb = new TronWeb({
    fullHost: 'https://api.trongrid.io',
    privateKey: '0000000000000000000000000000000000000000000000000000000000000001',
  })
  const sponsorTronWeb = new TronWeb({
    fullHost: 'https://api.trongrid.io',
    privateKey: '0000000000000000000000000000000000000000000000000000000000000002',
  })
  const ownerAddress = ownerTronWeb.defaultAddress.base58
  const sponsorAddress = sponsorTronWeb.defaultAddress.base58
  const replies = []
  const api = createWalletSignerAcceptanceApi({
    send: (_res, status, payload) => { replies.push({ status, payload }); return true },
    identityReport: {
      network: 'TRON Mainnet',
      owner: { address: ownerAddress },
      sponsor: { address: sponsorAddress },
      identitiesDistinct: true,
    },
    authenticateOwnerSession: async () => ({ address: ownerAddress, sessionId: 31 }),
    authenticateSponsorSession: async () => ({ address: sponsorAddress, sessionId: 32 }),
    tronWebFactory: () => new TronWeb({ fullHost: 'https://api.trongrid.io' }),
  })
  const challengeUrl = new URL('https://api.test/api/wallet-auth/owner/signing-challenge')
  await api.handle(makeRequest('GET'), {}, challengeUrl, origin)
  const challenge = replies.pop().payload
  const signature = await ownerTronWeb.trx.signMessageV2(challenge.message)
  await api.handle(makeRequest('POST', { origin, 'x-owner-csrf-token': 'owner-csrf' }, {
    challengeId: challenge.challengeId, signature,
  }), {}, new URL(challengeUrl.href + '/verify'), origin)
  const verified = replies.pop()
  assert.equal(verified.status, 200)
  assert.equal(verified.payload.verified, true)
  assert.equal(verified.payload.address, ownerAddress)
  assert.equal(verified.payload.broadcast, false)
})
