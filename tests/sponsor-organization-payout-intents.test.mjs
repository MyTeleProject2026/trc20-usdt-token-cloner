import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import express from 'express'
import { reserveSponsorOrganizationPayoutIntent } from '../server/sponsor-organization-payout-intents.mjs'
import { createSponsorOrganizationSelectionRouter } from '../server/routes/sponsor-organization-selection.mjs'

const ADMIN_TOKEN = 'test-sponsor-admin-token-that-is-long-enough-123456'
const PRINCIPAL_ADDRESS = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'
const FEE_ADDRESS = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const RECEIVER_ADDRESS = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE'
const WALLET_ORIGIN = 'https://studio.example.com'
const PRINCIPAL_SESSION = 'p'.repeat(43)
const FEE_SESSION = 'f'.repeat(43)

function links({ sameOrganization = false, sameWallet = false } = {}) {
  return [
    {
      id: '31', organizationId: '101', organizationReference: 'principal-org',
      organizationStatus: 'approved', accountId: '201', accountReference: 'principal-account',
      network: 'nile', role: 'asset-principal', sponsorAddress: PRINCIPAL_ADDRESS,
      accountStatus: 'verified', budgetId: '301', sponsorReference: 'principal-budget',
      purpose: 'asset-grant', asset: 'TRX', tokenContract: null, budgetStatus: 'active',
      linkStatus: 'active', agreementScopeVerified: true, linkCurrentlyActive: true,
    },
    {
      id: '32', organizationId: sameOrganization ? '101' : '102', organizationReference: 'fee-org',
      organizationStatus: 'approved', accountId: '202', accountReference: 'fee-account',
      network: 'nile', role: 'network-fee', sponsorAddress: sameWallet ? PRINCIPAL_ADDRESS : FEE_ADDRESS,
      accountStatus: 'verified', budgetId: '302', sponsorReference: 'fee-budget',
      purpose: 'network-fee', asset: 'TRX', tokenContract: null, budgetStatus: 'active',
      linkStatus: 'active', agreementScopeVerified: true, linkCurrentlyActive: true,
    },
  ]
}

function snapshots(network, feeAddress, principalAddress) {
  const make = (sponsorAddress) => ({
    status: 'solidified-sponsor-balances-read',
    onChainBalanceRead: true,
    network,
    sponsorAddress,
    source: 'Tatum TRON SolidityNode account and constant-contract queries',
    checkedAt: new Date().toISOString(),
    cache: { status: 'fresh', ageMs: 0 },
  })
  return {
    networkFeeSponsor: make(feeAddress),
    assetPrincipalSponsor: make(principalAddress),
  }
}

function roleFunding(network, feeAddress, principalAddress, delegation = true) {
  return {
    fundingSnapshots: snapshots(network, feeAddress, principalAddress),
    roles: { networkFeeSponsor: { resourceStatus: { resourceRead: true } } },
    feeSponsorDelegationToPrincipal: delegation ? {
      success: true, status: 'solidified-delegation-state-read',
      fromAddress: feeAddress, toAddress: principalAddress,
      activeEnergyStakeSun: '1000000', activeBandwidthStakeSun: '0',
    } : { success: false, status: 'delegation-not-found' },
  }
}

function createStore(options = {}) {
  const state = { reserved: [], cancelled: [], expired: 0, challenges: [], consumed: [], authorizations: [] }
  return {
    state,
    async listBudgetLinks() { return { success: true, links: links(options) } },
    async reservePayoutIntent(input) {
      state.reserved.push(input)
      return {
        success: true, duplicate: false, intentId: '9001', idempotencyKey: input.idempotencyKey,
        intentDigest: 'a'.repeat(64), status: 'pending_authorization',
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        canSubmitSponsoredTransfer: false, submissionEnabled: false,
      }
    },
    async cancelPayoutIntent(id, reviewReference) {
      state.cancelled.push({ id, reviewReference })
      return { success: true, duplicate: false, status: 'cancelled', reservationReleased: true }
    },
    async expirePayoutIntents({ limit }) {
      state.expired += 1
      return { success: true, expiredCount: limit > 0 ? 2 : 0 }
    },
    async createPayoutAuthorizationChallenge(intentId, role, { sessionAddress, sessionNetwork }) {
      const expectedAddress = role === 'asset-principal' ? PRINCIPAL_ADDRESS : FEE_ADDRESS
      if (sessionAddress !== expectedAddress || sessionNetwork !== 'nile') {
        return { success: false, reason: 'wallet-session-does-not-match-sponsor-role' }
      }
      const challenge = {
        id: String(state.challenges.length + 1), intentId, role,
        sponsorAddress: expectedAddress, network: 'nile',
        nonce: (state.challenges.length + 1).toString(16).padStart(64, '0'),
        message: 'Exact sponsor intent message for ' + role + '\nIntent digest: ' + 'a'.repeat(64) + '\nThis message does not sign, submit, broadcast, transfer, or debit funds.',
        intentDigest: 'a'.repeat(64),
        expiresAt: new Date(Date.now() + 120000).toISOString(),
      }
      state.challenges.push({ ...challenge, consumed: false })
      return { success: true, challenge, canSubmitSponsoredTransfer: false, submissionEnabled: false }
    },
    async consumePayoutAuthorizationChallenge(intentId, role, nonce, { sessionAddress, sessionNetwork }) {
      const challenge = state.challenges.find((item) => item.intentId === intentId
        && item.role === role && item.nonce === nonce && !item.consumed)
      if (!challenge) return { success: false, reason: 'sponsor-authorization-challenge-not-found-or-consumed' }
      if (challenge.sponsorAddress !== sessionAddress || challenge.network !== sessionNetwork) {
        return { success: false, reason: 'wallet-session-or-sponsor-scope-mismatch' }
      }
      challenge.consumed = true
      const value = {
        challengeId: challenge.id, intentId, role, intentDigest: challenge.intentDigest,
        sponsorAddress: challenge.sponsorAddress, network: challenge.network,
        message: challenge.message, messageHash: 'b'.repeat(64),
      }
      state.consumed.push(value)
      return { success: true, authorization: value }
    },
    async recordPayoutAuthorization(input) {
      state.authorizations.push(input)
      const roles = [...new Set(state.authorizations.map((item) => item.role))]
      const both = roles.includes('asset-principal') && roles.includes('network-fee')
      return {
        success: true, status: both ? 'sponsor_authorization_complete' : 'pending_authorization',
        authorizedRoles: roles, missingRoles: ['asset-principal', 'network-fee'].filter((role) => !roles.includes(role)),
        bothSponsorsAuthorized: both, sponsorAuthorizationVerified: true,
        canSubmitSponsoredTransfer: false, submissionEnabled: false, transactionSubmitted: false,
      }
    },
  }
}

const baseInput = {
  idempotencyKey: 'dual-sponsor-intent-test-0001',
  network: 'nile',
  asset: 'TRX',
  tokenContract: null,
  receiverAddress: RECEIVER_ADDRESS,
  amountBaseUnits: '2500000',
  feeCapSun: '120000',
  principalLinkId: '31',
  feeLinkId: '32',
}

test('dual sponsor intent reserves two independently owned budget links and remains pending authorization', async () => {
  const store = createStore()
  const result = await reserveSponsorOrganizationPayoutIntent({
    store, env: {}, input: baseInput,
    readRoleFunding: async (...args) => roleFunding(...args),
  })
  assert.equal(result.success, true)
  assert.equal(result.status, 'pending_authorization')
  assert.equal(result.intent.amountBaseUnits, '2500000')
  assert.equal(result.intent.feeCapSun, '120000')
  assert.equal(result.transactionSpecificFeeCoverageVerified, false)
  assert.equal(result.sponsorAuthorizationVerified, false)
  assert.equal(result.transactionSubmitted, false)
  assert.equal(result.canSubmitSponsoredTransfer, false)
  assert.equal(result.submissionEnabled, false)
  assert.equal(store.state.reserved.length, 1)
  assert.equal(store.state.reserved[0].fundingSnapshots.networkFeeSponsor.sponsorAddress, FEE_ADDRESS)
  assert.equal(store.state.reserved[0].fundingSnapshots.assetPrincipalSponsor.sponsorAddress, PRINCIPAL_ADDRESS)
})

test('dual sponsor intent rejects shared organizations or shared wallet addresses', async () => {
  for (const options of [{ sameOrganization: true }, { sameWallet: true }]) {
    const store = createStore(options)
    const result = await reserveSponsorOrganizationPayoutIntent({
      store, env: {}, input: baseInput,
      readRoleFunding: async (...args) => roleFunding(...args),
    })
    assert.equal(result.success, false)
    assert.equal(result.reason, 'independent-approved-principal-and-fee-budget-links-required')
    assert.equal(store.state.reserved.length, 0)
  }
})

test('dual sponsor intent fails closed when current fee delegation is not observed', async () => {
  const store = createStore()
  const result = await reserveSponsorOrganizationPayoutIntent({
    store, env: {}, input: baseInput,
    readRoleFunding: async (network, fee, principal) => roleFunding(network, fee, principal, false),
  })
  assert.equal(result.success, false)
  assert.equal(result.reason, 'active-fee-to-principal-resource-delegation-not-observed')
  assert.equal(store.state.reserved.length, 0)
})

test('dual sponsor intent rejects a stale exact-wallet funding snapshot', async () => {
  const store = createStore()
  const readRoleFunding = async (network, fee, principal) => {
    const value = roleFunding(network, fee, principal)
    value.fundingSnapshots.networkFeeSponsor.checkedAt = new Date(Date.now() - 60000).toISOString()
    return value
  }
  const result = await reserveSponsorOrganizationPayoutIntent({ store, env: {}, input: baseInput, readRoleFunding })
  assert.equal(result.success, false)
  assert.equal(result.reason, 'fresh-role-specific-funding-snapshots-required')
  assert.equal(store.state.reserved.length, 0)
})

async function serve(t, store, readRoleFunding, options = {}) {
  const app = express()
  app.use(express.json({ limit: '32kb' }))
  app.use('/api/tron', createSponsorOrganizationSelectionRouter({
    env: { SPONSOR_ADMIN_API_TOKEN: ADMIN_TOKEN, FRONTEND_ORIGIN: WALLET_ORIGIN },
    store,
    readRoleFunding,
    readWalletSession: options.readWalletSession,
    verifyMessage: options.verifyMessage,
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  return 'http://127.0.0.1:' + server.address().port + '/api/tron'
}

function adminHeaders() {
  return { authorization: 'Bearer ' + ADMIN_TOKEN, 'content-type': 'application/json' }
}

const baseHttpInput = {
  idempotencyKey: baseInput.idempotencyKey,
  network: baseInput.network,
  asset: baseInput.asset,
  receiverAddress: baseInput.receiverAddress,
  amountBaseUnits: baseInput.amountBaseUnits,
  feeCapSun: baseInput.feeCapSun,
  principalBudgetLinkId: baseInput.principalLinkId,
  feeBudgetLinkId: baseInput.feeLinkId,
}

test('payout intent HTTP route requires admin auth and rejects secret-bearing fields', async (t) => {
  const store = createStore()
  const base = await serve(t, store, async (...args) => roleFunding(...args))
  const denied = await fetch(base + '/sponsorship/organizations/payout-intents', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(baseHttpInput),
  })
  assert.equal(denied.status, 401)
  const rejected = await fetch(base + '/sponsorship/organizations/payout-intents', {
    method: 'POST', headers: adminHeaders(), body: JSON.stringify({ ...baseHttpInput, privateKey: 'never-accept' }),
  })
  assert.equal(rejected.status, 400)
  assert.equal(store.state.reserved.length, 0)
})

test('payout intent HTTP route returns a non-submittable pending authorization record', async (t) => {
  const store = createStore()
  const base = await serve(t, store, async (...args) => roleFunding(...args))
  const response = await fetch(base + '/sponsorship/organizations/payout-intents', {
    method: 'POST', headers: adminHeaders(), body: JSON.stringify(baseHttpInput),
  })
  const payload = await response.json()
  assert.equal(response.status, 201)
  assert.equal(payload.status, 'pending_authorization')
  assert.equal(payload.intent.id, '9001')
  assert.equal(payload.transactionSubmitted, false)
  assert.equal(payload.canSubmitSponsoredTransfer, false)
  assert.equal(payload.submissionEnabled, false)
})

test('payout intent cancellation and expiry endpoints require administrator authorization', async (t) => {
  const store = createStore()
  const base = await serve(t, store, async (...args) => roleFunding(...args))
  const denied = await fetch(base + '/sponsorship/payout-intents/9001/cancel', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reviewReference: 'cancel-review-01' }),
  })
  assert.equal(denied.status, 401)
  const cancelled = await fetch(base + '/sponsorship/payout-intents/9001/cancel', {
    method: 'POST', headers: adminHeaders(), body: JSON.stringify({ reviewReference: 'cancel-review-01' }),
  })
  assert.equal(cancelled.status, 200)
  assert.equal((await cancelled.json()).reservationReleased, true)
  const expired = await fetch(base + '/sponsorship/payout-intents/expire', {
    method: 'POST', headers: adminHeaders(), body: JSON.stringify({ limit: 10 }),
  })
  assert.equal(expired.status, 200)
  assert.equal((await expired.json()).expiredCount, 2)
})



function walletHeaders(token) {
  return {
    authorization: 'Bearer ' + token,
    origin: WALLET_ORIGIN,
    'content-type': 'application/json',
  }
}

test('sponsor owner challenges require a matching wallet identity session and are role-scoped', async (t) => {
  const store = createStore()
  const principalTokenHash = await import('node:crypto').then(({ createHash }) =>
    createHash('sha256').update(PRINCIPAL_SESSION).digest('hex'))
  const feeTokenHash = await import('node:crypto').then(({ createHash }) =>
    createHash('sha256').update(FEE_SESSION).digest('hex'))
  const base = await serve(t, store, null, {
    readWalletSession: async ({ tokenHash, origin }) => ({
      success: origin === WALLET_ORIGIN,
      session: tokenHash === principalTokenHash
        ? { address: PRINCIPAL_ADDRESS, network: 'nile', origin, expiresAt: Date.now() + 600000 }
        : tokenHash === feeTokenHash
          ? { address: FEE_ADDRESS, network: 'nile', origin, expiresAt: Date.now() + 600000 }
          : null,
    }),
  })

  const missingSession = await fetch(base + '/sponsorship/payout-intents/9001/authorization-challenges', {
    method: 'POST', headers: { origin: WALLET_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'asset-principal' }),
  })
  assert.equal(missingSession.status, 401)

  const wrongRoleSession = await fetch(base + '/sponsorship/payout-intents/9001/authorization-challenges', {
    method: 'POST', headers: walletHeaders(PRINCIPAL_SESSION),
    body: JSON.stringify({ role: 'network-fee' }),
  })
  assert.equal(wrongRoleSession.status, 403)

  const challenge = await fetch(base + '/sponsorship/payout-intents/9001/authorization-challenges', {
    method: 'POST', headers: walletHeaders(PRINCIPAL_SESSION),
    body: JSON.stringify({ role: 'asset-principal' }),
  })
  const challengePayload = await challenge.json()
  assert.equal(challenge.status, 201)
  assert.equal(challengePayload.challenge.role, 'asset-principal')
  assert.equal(challengePayload.challenge.sponsorAddress, PRINCIPAL_ADDRESS)
  assert.match(challengePayload.challenge.message, /Intent digest/)
  assert.match(challengePayload.challenge.message, /does not sign, submit, broadcast/)
  assert.equal(challengePayload.canSubmitSponsoredTransfer, false)
})

test('both sponsor owners must cryptographically approve the exact intent; signatures are never stored raw', async (t) => {
  const store = createStore()
  const crypto = await import('node:crypto')
  const principalHash = crypto.createHash('sha256').update(PRINCIPAL_SESSION).digest('hex')
  const feeHash = crypto.createHash('sha256').update(FEE_SESSION).digest('hex')
  const base = await serve(t, store, null, {
    readWalletSession: async ({ tokenHash, origin }) => ({
      success: origin === WALLET_ORIGIN,
      session: tokenHash === principalHash
        ? { address: PRINCIPAL_ADDRESS, network: 'nile', origin, expiresAt: Date.now() + 600000 }
        : tokenHash === feeHash
          ? { address: FEE_ADDRESS, network: 'nile', origin, expiresAt: Date.now() + 600000 }
          : null,
    }),
    verifyMessage: async (message, signature) => {
      if (!message.startsWith('Exact sponsor intent message for ')) throw new Error('unexpected message')
      if (signature === '0x' + '1'.repeat(130)) return PRINCIPAL_ADDRESS
      if (signature === '0x' + '2'.repeat(130)) return FEE_ADDRESS
      return 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE'
    },
  })

  async function requestChallenge(role, token) {
    const response = await fetch(base + '/sponsorship/payout-intents/9001/authorization-challenges', {
      method: 'POST', headers: walletHeaders(token), body: JSON.stringify({ role }),
    })
    assert.equal(response.status, 201)
    return (await response.json()).challenge
  }
  async function authorize(role, token, challenge, signature) {
    return fetch(base + '/sponsorship/payout-intents/9001/authorize', {
      method: 'POST', headers: walletHeaders(token),
      body: JSON.stringify({ role, nonce: challenge.nonce, signature }),
    })
  }

  const principalChallenge = await requestChallenge('asset-principal', PRINCIPAL_SESSION)
  const principalSigned = await authorize('asset-principal', PRINCIPAL_SESSION, principalChallenge, '0x' + '1'.repeat(130))
  const first = await principalSigned.json()
  assert.equal(principalSigned.status, 200)
  assert.equal(first.status, 'pending_authorization')
  assert.deepEqual(first.missingRoles, ['network-fee'])
  assert.equal(first.bothSponsorsAuthorized, false)
  assert.equal(first.canSubmitSponsoredTransfer, false)
  assert.equal(store.state.authorizations.length, 1)
  assert.equal(Object.hasOwn(store.state.authorizations[0], 'signature'), false)
  assert.match(store.state.authorizations[0].signatureHash, /^[0-9a-f]{64}$/)

  const feeChallenge = await requestChallenge('network-fee', FEE_SESSION)
  const feeSigned = await authorize('network-fee', FEE_SESSION, feeChallenge, '0x' + '2'.repeat(130))
  const second = await feeSigned.json()
  assert.equal(feeSigned.status, 200)
  assert.equal(second.status, 'sponsor_authorization_complete')
  assert.equal(second.bothSponsorsAuthorized, true)
  assert.deepEqual(second.authorizedRoles.sort(), ['asset-principal', 'network-fee'])
  assert.equal(second.transactionAuthorizationVerified, false)
  assert.equal(second.canSubmitSponsoredTransfer, false)
  assert.equal(second.submissionEnabled, false)
  assert.equal(second.transactionSubmitted, false)

  const replay = await authorize('network-fee', FEE_SESSION, feeChallenge, '0x' + '2'.repeat(130))
  assert.equal(replay.status, 409)
  assert.equal(store.state.authorizations.length, 2)
})

test('a sponsor authorization signature recovering a different wallet is rejected and the nonce is burned', async (t) => {
  const store = createStore()
  const crypto = await import('node:crypto')
  const principalHash = crypto.createHash('sha256').update(PRINCIPAL_SESSION).digest('hex')
  const base = await serve(t, store, null, {
    readWalletSession: async ({ tokenHash, origin }) => ({
      success: true,
      session: tokenHash === principalHash
        ? { address: PRINCIPAL_ADDRESS, network: 'nile', origin, expiresAt: Date.now() + 600000 } : null,
    }),
    verifyMessage: async () => FEE_ADDRESS,
  })
  const challengeResponse = await fetch(base + '/sponsorship/payout-intents/9001/authorization-challenges', {
    method: 'POST', headers: walletHeaders(PRINCIPAL_SESSION),
    body: JSON.stringify({ role: 'asset-principal' }),
  })
  const challenge = (await challengeResponse.json()).challenge
  const response = await fetch(base + '/sponsorship/payout-intents/9001/authorize', {
    method: 'POST', headers: walletHeaders(PRINCIPAL_SESSION),
    body: JSON.stringify({ role: 'asset-principal', nonce: challenge.nonce, signature: '0x' + '3'.repeat(130) }),
  })
  assert.equal(response.status, 401)
  assert.equal((await response.json()).challengeConsumed, true)
  assert.equal(store.state.authorizations.length, 0)
  const replay = await fetch(base + '/sponsorship/payout-intents/9001/authorize', {
    method: 'POST', headers: walletHeaders(PRINCIPAL_SESSION),
    body: JSON.stringify({ role: 'asset-principal', nonce: challenge.nonce, signature: '0x' + '3'.repeat(130) }),
  })
  assert.equal(replay.status, 409)
})

