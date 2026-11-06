import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import express from 'express'
import { createServer } from 'node:http'
import { TronWeb } from 'tronweb'
import {
  parseSponsorDirectUsdtAmount,
  calculateSponsorDirectAvailableBaseUnits,
  parseSponsorDirectFeeParameters,
  calculateSponsorDirectFeeCoverage,
  matchesSponsorDirectUnsignedTransaction,
  isSponsorDirectAutoRouteEligible,
  createSponsorDirectPayoutsRouter,
} from '../server/routes/sponsor-direct-payouts.mjs'
import { buildOwnerUsdtTransferParameter, MAINNET_USDT_CONTRACT } from '../server/routes/tron-owner-withdrawals.mjs'

const sponsorAddress = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'
const recipientAddress = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const requesterAddress = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
const tronWeb = new TronWeb({ fullHost: 'https://tron-mainnet.gateway.tatum.io' })

const { Pool } = pg
const postgresIntegrationEnabled = process.env.SPONSOR_PG_INTEGRATION === '1'
const integrationDatabaseUrl = process.env.DATABASE_URL || ''

function assertIsolatedSponsorTestDatabase(value) {
  let parsed
  try { parsed = new URL(value) } catch {
    throw new Error('SPONSOR_PG_INTEGRATION requires a valid DATABASE_URL')
  }
  const databaseName = decodeURIComponent(parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : parsed.pathname)
  if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) || databaseName !== 'sponsor_test') {
    throw new Error('Refusing sponsor-direct integration tests outside the local dedicated sponsor_test database')
  }
}

test('sponsor-direct USDT amount parser accepts exact six-decimal amounts', () => {
  assert.equal(parseSponsorDirectUsdtAmount('1'), '1000000')
  assert.equal(parseSponsorDirectUsdtAmount('12.340056'), '12340056')
  assert.equal(parseSponsorDirectUsdtAmount('0.000001'), '1')
  assert.throws(() => parseSponsorDirectUsdtAmount('0'))
  assert.throws(() => parseSponsorDirectUsdtAmount('0.0000001'))
  assert.throws(() => parseSponsorDirectUsdtAmount('-1'))
  assert.throws(() => parseSponsorDirectUsdtAmount('1e2'))
  assert.throws(() => parseSponsorDirectUsdtAmount(1))
})

test('automatic sponsor routing requires available sponsor USDT, approved wallet limits, daily capacity and verified fee coverage', () => {
  const eligible = {
    amountBaseUnits: '25000000',
    balanceBaseUnits: '100000000',
    reservedBaseUnits: '25000000',
    perPayoutLimitBaseUnits: '50000000',
    dailyLimitBaseUnits: '100000000',
    dailyUsedBaseUnits: '25000000',
    feeCoverage: true,
  }
  assert.equal(isSponsorDirectAutoRouteEligible(eligible), true)
  assert.equal(isSponsorDirectAutoRouteEligible({ ...eligible, balanceBaseUnits: '40000000' }), false)
  assert.equal(isSponsorDirectAutoRouteEligible({ ...eligible, reservedBaseUnits: '80000000' }), false)
  assert.equal(isSponsorDirectAutoRouteEligible({ ...eligible, perPayoutLimitBaseUnits: '20000000' }), false)
  assert.equal(isSponsorDirectAutoRouteEligible({ ...eligible, dailyUsedBaseUnits: '80000000' }), false)
  assert.equal(isSponsorDirectAutoRouteEligible({ ...eligible, feeCoverage: false }), false)
  assert.equal(isSponsorDirectAutoRouteEligible({ ...eligible, amountBaseUnits: 'not-an-integer' }), false)
  assert.equal(isSponsorDirectAutoRouteEligible({ ...eligible, amountBaseUnits: '0' }), false)
  assert.equal(isSponsorDirectAutoRouteEligible({ ...eligible, dailyLimitBaseUnits: '49999999' }), false)
  assert.equal(isSponsorDirectAutoRouteEligible({ ...eligible, feeCoverage: 'true' }), false)
  assert.equal(isSponsorDirectAutoRouteEligible({ ...eligible, reservedBaseUnits: 'not-an-integer' }), false)
  assert.equal(isSponsorDirectAutoRouteEligible({ ...eligible, dailyUsedBaseUnits: '75000000' }), true)
})

test('sponsor-direct available balance subtracts reservations without going negative', () => {
  assert.equal(calculateSponsorDirectAvailableBaseUnits('100000000', '25000000'), '75000000')
  assert.equal(calculateSponsorDirectAvailableBaseUnits('1000000', '1000000'), '0')
  assert.equal(calculateSponsorDirectAvailableBaseUnits('1000000', '2000000'), '0')
  assert.throws(() => calculateSponsorDirectAvailableBaseUnits('-1', '0'))
  assert.throws(() => calculateSponsorDirectAvailableBaseUnits('1.2', '0'))
})

const mainnetFeeParameters = {
  energyPriceSun: '100',
  bandwidthPriceSun: '1000',
  maxFeeLimitSun: '15000000000',
}

test('TRON fee parameters are read from the current Mainnet chain parameters', () => {
  assert.deepEqual(parseSponsorDirectFeeParameters({
    chainParameter: [
      { key: 'getEnergyFee', value: 100 },
      { key: 'getTransactionFee', value: 1000 },
      { key: 'getMaxFeeLimit', value: 15000000000 },
    ],
  }), mainnetFeeParameters)
  assert.throws(() => parseSponsorDirectFeeParameters({ chainParameter: [{ key: 'getEnergyFee', value: 100 }] }))
})

test('Mainnet sponsor fee coverage calculates Energy cap and separate Bandwidth sources', () => {
  const snapshot = {
    energyAvailable: 2000,
    stakedBandwidthAvailable: 500,
    freeBandwidthAvailable: 600,
    trxBalanceSun: '0',
  }
  const simulation = { energy_used: 1000, energy_penalty: 100 }
  const unsigned = { raw_data_hex: 'ab'.repeat(200) }
  const covered = calculateSponsorDirectFeeCoverage(
    snapshot, simulation, unsigned, '200000', mainnetFeeParameters,
  )
  assert.equal(covered.covered, true)
  assert.equal(covered.energyRequired, 1320)
  assert.equal(covered.energyBudgetRequiredSun, '132000')
  assert.equal(covered.bandwidthRequired, 329)
  assert.equal(covered.bandwidthCoverageMethod, 'staked-bandwidth')
  assert.equal(covered.energyTrxReserveSun, '0')
  assert.equal(covered.bandwidthTrxReserveSun, '0')
  assert.equal(covered.totalTrxReserveSun, '0')
})

test('Mainnet sponsor fee coverage adds Energy and Bandwidth shortfalls to required TRX reserve', () => {
  const snapshot = {
    energyAvailable: 900,
    stakedBandwidthAvailable: 0,
    freeBandwidthAvailable: 0,
    trxBalanceSun: '370999',
  }
  const unsigned = { raw_data_hex: 'ab'.repeat(200) }
  const short = calculateSponsorDirectFeeCoverage(
    snapshot, { energy_used: 1000, energy_penalty: 100 }, unsigned, '200000', mainnetFeeParameters,
  )
  assert.equal(short.energyRequired, 1320)
  assert.equal(short.energyTrxReserveSun, '42000')
  assert.equal(short.bandwidthTrxReserveSun, '329000')
  assert.equal(short.totalTrxReserveSun, '371000')
  assert.equal(short.trxBalanceCoversReserve, false)
  assert.equal(short.covered, false)

  const sufficient = calculateSponsorDirectFeeCoverage(
    { ...snapshot, trxBalanceSun: '371000' },
    { energy_used: 1000, energy_penalty: 100 },
    unsigned,
    '200000',
    mainnetFeeParameters,
  )
  assert.equal(sufficient.covered, true)
  assert.equal(sufficient.method, 'mixed-resource-and-trx-reserve')
})

test('Mainnet sponsor fee coverage fails closed when fee_limit does not cover Energy or exceeds chain maximum', () => {
  const snapshot = {
    energyAvailable: 100000,
    stakedBandwidthAvailable: 1000,
    freeBandwidthAvailable: 1000,
    trxBalanceSun: '0',
  }
  const unsigned = { raw_data_hex: 'ab'.repeat(100) }
  const tooLow = calculateSponsorDirectFeeCoverage(
    snapshot, { energy_used: 1000, energy_penalty: 0 }, unsigned, '99999', mainnetFeeParameters,
  )
  assert.equal(tooLow.covered, false)
  assert.equal(tooLow.feeLimitCoversEnergy, false)
  const aboveMax = calculateSponsorDirectFeeCoverage(
    snapshot, { energy_used: 100, energy_penalty: 0 }, unsigned, '15000000001', mainnetFeeParameters,
  )
  assert.equal(aboveMax.covered, false)
})

function unsignedTransfer(overrides = {}) {
  const amountBaseUnits = '25000000'
  const parameter = buildOwnerUsdtTransferParameter(recipientAddress, amountBaseUnits, tronWeb)
  const rawDataHex = 'deadbeef'
  return {
    txID: createHash('sha256').update(Buffer.from(rawDataHex, 'hex')).digest('hex'),
    raw_data_hex: rawDataHex,
    raw_data: {
      expiration: Date.now() + 5 * 60 * 1000,
      contract: [{
        type: 'TriggerSmartContract',
        parameter: {
          value: {
            owner_address: tronWeb.address.toHex(sponsorAddress),
            contract_address: tronWeb.address.toHex(MAINNET_USDT_CONTRACT),
            call_value: 0,
            data: 'a9059cbb' + parameter,
          },
        },
      }],
    },
    ...overrides,
  }
}

test('unsigned sponsor transaction must bind the sponsor, official token, recipient and amount', () => {
  const tx = unsignedTransfer()
  const intent = { sponsorAddress, recipientAddress, amountBaseUnits: '25000000', tronWeb }
  assert.equal(matchesSponsorDirectUnsignedTransaction(tx, intent), true)
  assert.equal(matchesSponsorDirectUnsignedTransaction(tx, { ...intent, sponsorAddress: requesterAddress }), false)
  assert.equal(matchesSponsorDirectUnsignedTransaction(tx, { ...intent, recipientAddress: requesterAddress }), false)
  assert.equal(matchesSponsorDirectUnsignedTransaction(tx, { ...intent, amountBaseUnits: '25000001' }), false)
})

test('unsigned sponsor transaction rejects malformed tx IDs, expired data and non-single-call payloads', () => {
  const intent = { sponsorAddress, recipientAddress, amountBaseUnits: '25000000', tronWeb }
  const valid = unsignedTransfer()
  assert.equal(matchesSponsorDirectUnsignedTransaction({ ...valid, txID: 'z'.repeat(64) }, intent), false)
  assert.equal(matchesSponsorDirectUnsignedTransaction({
    ...valid,
    raw_data: { ...valid.raw_data, expiration: Date.now() - 1000 },
  }, intent), false)
  assert.equal(matchesSponsorDirectUnsignedTransaction({
    ...valid,
    raw_data: { ...valid.raw_data, contract: [...valid.raw_data.contract, ...valid.raw_data.contract] },
  }, intent), false)
})


test('PostgreSQL auto-matches one pending sponsor request, reserves its USDT, and returns the unsigned draft only to the sponsor', {
  skip: !postgresIntegrationEnabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
}, async (t) => {
  assertIsolatedSponsorTestDatabase(integrationDatabaseUrl)
  const db = new Pool({ connectionString: integrationDatabaseUrl })
  const origin = 'https://tron-transfer.integration.test'
  const requesterToken = 'r'.repeat(43)
  const sponsorToken = 's'.repeat(43)
  const ownerToken = 'o'.repeat(43)
  const ownerAddress = requesterAddress
  const outsiderToken = 'x'.repeat(43)
  const sessionAddresses = new Map([
    [createHash('sha256').update(requesterToken).digest('hex'), ownerAddress],
    [createHash('sha256').update(sponsorToken).digest('hex'), sponsorAddress],
    [createHash('sha256').update(ownerToken).digest('hex'), ownerAddress],
    [createHash('sha256').update(outsiderToken).digest('hex'), recipientAddress],
  ])
  let sponsorApplicationId = null
  const firstIdempotencyKey = randomUUID()
  const secondIdempotencyKey = randomUUID()
  const idempotencyKeys = [firstIdempotencyKey, secondIdempotencyKey]
  let server

  try {
    await db.query('CREATE SCHEMA IF NOT EXISTS trc20_token_clone')
    const app = express()
    app.use(express.json())
    app.use('/api/tron/sponsor-direct', createSponsorDirectPayoutsRouter({
      env: {
        DATABASE_URL: integrationDatabaseUrl,
        FRONTEND_ORIGIN: origin,
        OWNER_WALLET_ADDRESS: ownerAddress,
        TATUM_API_KEY: 'integration-test-key',
      },
      getSession: async ({ tokenHash, origin: requestOrigin }) => {
        const address = sessionAddresses.get(tokenHash)
        return address ? {
          success: true,
          session: {
            address,
            network: 'mainnet',
            origin: requestOrigin,
            expiresAt: Date.now() + 60 * 60 * 1000,
          },
        } : { success: true, session: null }
      },
      getDatabase: () => db,
      readSnapshot: async (_env, address) => ({
        sponsorAddress: address,
        network: 'mainnet',
        tokenContract: MAINNET_USDT_CONTRACT,
        usdtBalanceBaseUnits: '100000000',
        trxBalanceSun: '0',
        energyAvailable: 100000,
        stakedBandwidthAvailable: 100000,
        freeBandwidthAvailable: 100000,
        bandwidthAvailable: 200000,
        resourcesReadable: true,
        checkedAt: new Date().toISOString(),
      }),
      providerPost: async (_env, providerPath) => {
        if (providerPath === 'wallet/getchainparameters') {
          return { chainParameter: [
            { key: 'getEnergyFee', value: 100 },
            { key: 'getTransactionFee', value: 1000 },
            { key: 'getMaxFeeLimit', value: 15000000000 },
          ] }
        }
        if (providerPath === 'wallet/triggerconstantcontract') {
          return { result: { result: true }, energy_used: 100, energy_penalty: 0 }
        }
        if (providerPath === 'wallet/triggersmartcontract') {
          return { result: { result: true }, transaction: unsignedTransfer() }
        }
        throw new Error('Unexpected Tatum integration-test path: ' + providerPath)
      },
    }))

    await new Promise((resolve) => {
      server = createServer(app)
      server.listen(0, '127.0.0.1', resolve)
    })

    const baseUrl = 'http://127.0.0.1:' + server.address().port
    async function call(path, token, body) {
      const response = await fetch(baseUrl + '/api/tron/sponsor-direct' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Origin: origin,
          Authorization: 'Bearer ' + token,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      return { response, payload: await response.json() }
    }

    const initialized = await call('/application', sponsorToken)
    assert.equal(initialized.response.status, 200)
    assert.equal(initialized.payload.application, null)

    await db.query('DELETE FROM trc20_token_clone.sponsor_direct_payouts WHERE requester_address=$1 OR sponsor_address=$2', [requesterAddress, sponsorAddress])
    await db.query('DELETE FROM trc20_token_clone.sponsor_direct_applications WHERE sponsor_address=$1', [sponsorAddress])
    const registration = await call('/application', sponsorToken, { displayName: 'Individual sponsor' })
    assert.equal(registration.response.status, 201)
    sponsorApplicationId = registration.payload.application.id
    assert.equal(registration.payload.application.status, 'pending-review')
    assert.equal(registration.payload.complianceVerified, false)
    const ownerReview = await call('/applications/' + registration.payload.application.id + '/review', ownerToken, {
      decision: 'approve',
      reviewReference: 'wallet-sponsor-review-001',
      perPayoutLimit: '50',
      dailyLimit: '100',
    })
    assert.equal(ownerReview.response.status, 200)
    assert.equal(ownerReview.payload.application.status, 'active')
    assert.equal(ownerReview.payload.complianceVerified, false)
    const outsiderRequest = await call('/requests', outsiderToken, {
      recipientAddress,
      amount: '25',
      idempotencyKey: randomUUID(),
    })
    assert.equal(outsiderRequest.response.status, 403)
    assert.equal(outsiderRequest.payload.error, 'platform-owner-only')

    const first = await call('/requests', requesterToken, {
      recipientAddress,
      amount: '25',
      idempotencyKey: firstIdempotencyKey,
    })
    assert.equal(first.response.status, 201)
    assert.equal(first.payload.sponsorRouting, 'auto-assigned-awaiting-sponsor-signature')
    assert.equal(first.payload.payoutAuthorized, false)
    assert.equal(first.payload.transactionBroadcast, false)
    assert.equal(first.payload.request.sponsorAddress, sponsorAddress)

    const second = await call('/requests', requesterToken, {
      recipientAddress,
      amount: '25',
      idempotencyKey: secondIdempotencyKey,
    })
    assert.equal(second.response.status, 201)
    assert.equal(second.payload.sponsorRouting, 'awaiting-eligible-sponsor')
    assert.equal(second.payload.request.sponsorAddress, null)

    const readiness = await call('/readiness', sponsorToken)
    assert.equal(readiness.response.status, 200)
    assert.equal(readiness.payload.reservedUsdtBaseUnits, '25000000')
    assert.equal(readiness.payload.availableUsdtBaseUnits, '75000000')
    assert.equal(readiness.payload.dailyUsedBaseUnits, '25000000')

    const prepared = await call('/requests/' + first.payload.request.id + '/prepare', sponsorToken, {})
    assert.equal(prepared.response.status, 201)
    assert.equal(prepared.payload.request.status, 'prepared')
    assert.equal(prepared.payload.feeCoverage.covered, true)

    const sponsorQueue = await call('/queue', sponsorToken)
    assert.equal(sponsorQueue.response.status, 200)
    const savedDraft = sponsorQueue.payload.requests.find((item) => item.id === first.payload.request.id)
    assert.equal(savedDraft.status, 'prepared')
    assert.equal(savedDraft.unsignedTransaction.txID, prepared.payload.unsignedTransaction.txID)

    const requesterHistory = await call('/my-requests', requesterToken)
    assert.equal(requesterHistory.response.status, 200)
    const requesterCopy = requesterHistory.payload.requests.find((item) => item.id === first.payload.request.id)
    assert.equal(requesterCopy.unsignedTransaction, undefined)
  } finally {
    await db.query('DELETE FROM trc20_token_clone.sponsor_direct_payouts WHERE idempotency_key = ANY($1::uuid[])', [idempotencyKeys]).catch(() => {})
    await db.query('DELETE FROM trc20_token_clone.sponsor_direct_applications WHERE id=$1', [sponsorApplicationId]).catch(() => {})
    if (server) await new Promise((resolve) => server.close(resolve))
    await db.end()
  }
})

test('public sponsor-direct configuration allows a zero-balance requester but requires sponsor funding and signature', async (t) => {
  const app = express()
  app.use('/api/tron/sponsor-direct', createSponsorDirectPayoutsRouter({ env: {} }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))

  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/tron/sponsor-direct/config')
  const payload = await response.json()
  assert.equal(response.status, 200)
  assert.equal(payload.network, 'mainnet')
  assert.equal(payload.asset, 'USDT')
  assert.equal(payload.tokenContract, MAINNET_USDT_CONTRACT)
  assert.equal(payload.requesterWalletFundingRequired, false)
  assert.equal(payload.sponsorWalletFundingRequired, true)
  assert.equal(payload.sponsorWalletSignatureRequired, true)
  assert.equal(payload.requestIntakeEnabled, true)
  assert.equal(payload.requesterWalletFundingRequired, false)
  assert.equal(payload.payoutMode, 'sponsor-direct')
  assert.equal(payload.payoutExecution, 'conditional-on-approved-funded-sponsor')
  assert.equal(payload.sponsorApprovalRequired, true)
})

test('owner-only funding overview reports zero approved sponsors without implying live funding', async (t) => {
  const ownerToken = 'o'.repeat(43)
  const origin = 'https://tron-transfer.integration.test'
  const database = {
    async query(sql) {
      if (sql.startsWith('SELECT COUNT(*)::int AS total')
        && sql.includes('sponsor_direct_applications')) {
        return { rows: [{ total: 0, approved: 0, pending_review: 0, declined: 0, suspended: 0 }] }
      }
      if (sql.startsWith('SELECT COUNT(*)::int AS total')
        && sql.includes('sponsor_direct_payouts')) {
        return {
          rows: [{
            total: 0,
            awaiting_sponsor: 0,
            matched_awaiting_signature: 0,
            prepared: 0,
            submitted_or_reconciling: 0,
            confirmed: 0,
            attention_required: 0,
          }],
        }
      }
      return { rows: [], rowCount: 0 }
    },
  }
  const app = express()
  app.use('/api/tron/sponsor-direct', createSponsorDirectPayoutsRouter({
    env: { FRONTEND_ORIGIN: origin, OWNER_WALLET_ADDRESS: requesterAddress },
    getSession: async ({ origin: requestOrigin }) => ({
      success: true,
      session: {
        address: requesterAddress,
        network: 'mainnet',
        origin: requestOrigin,
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
    }),
    getDatabase: () => database,
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))

  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/tron/sponsor-direct/owner-overview', {
    headers: { Origin: origin, Authorization: 'Bearer ' + ownerToken },
  })
  const payload = await response.json()
  assert.equal(response.status, 200)
  assert.equal(payload.network, 'mainnet')
  assert.equal(payload.sponsorProfiles.approved, 0)
  assert.equal(payload.sponsorProfiles.pendingReview, 0)
  assert.equal(payload.funding.status, 'no-approved-sponsor-wallets')
  assert.equal(payload.funding.approvedSponsorProfilesExist, false)
  assert.equal(payload.funding.liveSponsorFundingVerified, false)
  assert.equal(payload.funding.canPayWithoutRealMainnetUsdt, false)
  assert.equal(payload.requesterWalletFundingRequired, false)
  assert.equal(payload.individualSponsorCompanyRegistrationRequiredByThisApplication, false)
  assert.equal(payload.individualSponsorContactEmailRequired, false)
  assert.equal(payload.complianceVerified, false)
  assert.equal(JSON.stringify(payload).includes(sponsorAddress), false)
})

