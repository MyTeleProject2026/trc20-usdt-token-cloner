import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createOwnerTreasuryRouter, resolveOwnerTreasuryFundingAddress } from '../server/routes/owner-treasury.mjs'

const ownerAddress = 'T' + 'A'.repeat(33)
const sessionToken = 's'.repeat(43)
const origin = 'https://localhost'

function responseRecorder() {
  let statusCode = 200
  let body = null
  const headers = {}
  return {
    status(code) { statusCode = code; return this },
    setHeader(name, value) { headers[name.toLowerCase()] = value; return this },
    json(value) { body = value; return this },
    get statusCode() { return statusCode },
    get body() { return body },
    headers,
  }
}

function routeHandler(router) {
  const layer = router.stack.find(item => item.route?.path === '/funding-status' && item.route.methods?.get)
  assert.ok(layer, 'GET /funding-status is registered')
  return layer.route.stack[0].handle
}

function request({ token = sessionToken, network = 'mainnet', requestOrigin = origin } = {}) {
  return {
    query: { network },
    headers: { authorization: token ? 'Bearer ' + token : '', origin: requestOrigin },
    get(name) { return this.headers[name.toLowerCase()] || '' },
    params: {},
  }
}

function makeRouter({ env = { TREASURY_OWNER_ADDRESS: ownerAddress }, session = null, funding = null, valid = () => true } = {}) {
  return createOwnerTreasuryRouter({
    env,
    isValidAddress: valid,
    getSession: async (input) => {
      assert.equal(input.origin, origin)
      assert.match(input.tokenHash, /^[0-9a-f]{64}$/)
      return { success: true, session }
    },
    readFunding: async (network) => {
      assert.equal(network, 'mainnet')
      return funding
    },
    now: () => Date.parse('2026-10-28T00:00:00.000Z'),
  })
}

test('treasury watch address prefers dedicated configuration and safely falls back', () => {
  assert.equal(resolveOwnerTreasuryFundingAddress({
    TREASURY_MAINNET_ADDRESS: 'T' + 'D'.repeat(33),
    SPONSOR_MAINNET_ADDRESS: 'T' + 'S'.repeat(33),
    TREASURY_OWNER_ADDRESS: ownerAddress,
  }), 'T' + 'D'.repeat(33))
  assert.equal(resolveOwnerTreasuryFundingAddress({
    SPONSOR_MAINNET_ADDRESS: 'T' + 'S'.repeat(33),
    TREASURY_OWNER_ADDRESS: ownerAddress,
  }), 'T' + 'S'.repeat(33))
  assert.equal(resolveOwnerTreasuryFundingAddress({ TREASURY_OWNER_ADDRESS: ownerAddress }), ownerAddress)
  assert.equal(resolveOwnerTreasuryFundingAddress({}), '')
})

test('owner treasury endpoint fails closed when owner address is not configured', async () => {
  const handler = routeHandler(makeRouter({ env: {} }))
  const res = responseRecorder()
  await handler(request(), res)
  assert.equal(res.statusCode, 503)
  assert.equal(res.body.error, 'treasury-owner-not-configured')
  assert.equal(res.body.submissionEnabled, false)
})

test('owner treasury endpoint requires a signed owner session on Mainnet', async () => {
  const handler = routeHandler(makeRouter({ session: null }))
  const noToken = responseRecorder()
  await handler(request({ token: '' }), noToken)
  assert.equal(noToken.statusCode, 401)
  assert.equal(noToken.body.error, 'owner-session-required')

  const wrongNetwork = responseRecorder()
  await handler(request({ network: 'nile' }), wrongNetwork)
  assert.equal(wrongNetwork.statusCode, 400)
  assert.equal(wrongNetwork.body.error, 'mainnet-required')
})

test('owner treasury endpoint rejects a wallet other than the configured owner', async () => {
  const router = makeRouter({
    session: { address: 'T' + 'B'.repeat(33), network: 'mainnet', origin },
  })
  const res = responseRecorder()
  await routeHandler(router)(request(), res)
  assert.equal(res.statusCode, 403)
  assert.equal(res.body.error, 'owner-wallet-not-authorized')
  assert.equal(res.body.canSubmitSponsoredTransfer, false)
})

test('owner treasury endpoint returns only verified funding facts and never enables payout submission', async () => {
  const calls = []
  const router = createOwnerTreasuryRouter({
    env: { TREASURY_OWNER_ADDRESS: ownerAddress },
    isValidAddress: () => true,
    getSession: async ({ tokenHash, origin: receivedOrigin }) => {
      calls.push({ tokenHash, origin: receivedOrigin })
      return { success: true, session: { address: ownerAddress, network: 'mainnet', origin } }
    },
    readFunding: async () => ({
      onChainBalanceRead: true,
      status: 'solidified-sponsor-balances-read',
      checkedAt: '2026-10-28T00:00:00.000Z',
      sponsorAddress: 'T' + 'C'.repeat(33),
      native: { status: 'verified', balanceTRX: '23.5' },
      tokens: [
        { asset: 'USDT', tokenContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', status: 'verified', balanceBaseUnits: '12345678', decimals: 6 },
      ],
    }),
    now: () => Date.parse('2026-10-28T00:00:00.000Z'),
  })
  const res = responseRecorder()
  await routeHandler(router)(request(), res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.success, true)
  assert.equal(res.body.ownerAccessVerified, true)
  assert.equal(res.body.treasuryAddress, 'T' + 'C'.repeat(33))
  assert.deepEqual(res.body.officialUsdt, {
    status: 'verified',
    tokenContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    balanceBaseUnits: '12345678',
    decimals: 6,
  })
  assert.equal(res.body.canSubmitSponsoredTransfer, false)
  assert.equal(res.body.submissionEnabled, false)
  assert.equal(Object.hasOwn(res.body, 'transactionHash'), false)
  assert.equal(calls.length, 1)
})

test('wallet UI exposes only owner-authenticated read-only funding, not generated or fabricated balances', async () => {
  const ui = await readFile(new URL('../src/WalletVault.tsx', import.meta.url), 'utf8')
  assert.ok(ui.includes('/api/treasury/owner/funding-status?network=mainnet'))
  assert.ok(ui.includes('ownerAccessVerified'))
  assert.ok(ui.includes('Read-only treasury funding check'))
  assert.ok(ui.toLowerCase().includes('no usdt is generated'))
  assert.ok(ui.includes('TREASURY_MAINNET_ADDRESS'))
  assert.ok(ui.includes('The watched treasury address is different from the currently unlocked wallet'))
  assert.ok(ui.includes('canSubmitSponsoredTransfer'))
})
