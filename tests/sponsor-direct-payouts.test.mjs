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

test('automatic sponsor routing requires actual available USDT, mandate limits, daily capacity and verified fee coverage', () => {
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
  const sessionAddresses = new Map([
    [createHash('sha256').update(requesterToken).digest('hex'), requesterAddress],
    [createHash('sha256').update(sponsorToken).digest('hex'), sponsorAddress],
  ])
  const ownerAddress = recipientAddress
  const organizationApplicationId = randomUUID()
  const mandateId = randomUUID()
  const sponsorApplicationId = randomUUID()
  const firstIdempotencyKey = randomUUID()
  const secondIdempotencyKey = randomUUID()
  const idempotencyKeys = [firstIdempotencyKey, secondIdempotencyKey]
  let server

  try {
    await db.query('CREATE SCHEMA IF NOT EXISTS trc20_token_clone')
    await db.query(
      'CREATE TABLE IF NOT EXISTS trc20_token_clone.sponsor_organization_applications (' +
      'id UUID PRIMARY KEY, sponsor_wallet_address TEXT NOT NULL, organization_name TEXT NOT NULL, ' +
      'business_email TEXT NOT NULL, jurisdiction TEXT NOT NULL, website TEXT, requested_roles JSONB NOT NULL, ' +
      'application_signature_hash CHAR(64) NOT NULL, status TEXT NOT NULL, review_reference TEXT, ' +
      'reviewed_by_address TEXT, reviewed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), ' +
      'updated_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    )
    await db.query(
      'CREATE TABLE IF NOT EXISTS trc20_token_clone.sponsor_organization_mandates (' +
      'id UUID PRIMARY KEY, application_id UUID NOT NULL, sponsor_wallet_address TEXT NOT NULL, ' +
      'agreement_reference TEXT NOT NULL, agreement_digest CHAR(64) NOT NULL, purpose TEXT NOT NULL, ' +
      'per_payout_limit_base_units NUMERIC(78,0) NOT NULL, daily_limit_base_units NUMERIC(78,0) NOT NULL, ' +
      'valid_from TIMESTAMPTZ NOT NULL, valid_until TIMESTAMPTZ NOT NULL, sponsor_signature_hash CHAR(64) NOT NULL, ' +
      'status TEXT NOT NULL, review_reference TEXT, reviewed_by_address TEXT, reviewed_at TIMESTAMPTZ, ' +
      'created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    )

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
        bandwidthAvailable: 100000,
        resourcesReadable: true,
        checkedAt: new Date().toISOString(),
      }),
      providerPost: async (_env, providerPath) => {
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
    await db.query('DELETE FROM trc20_token_clone.sponsor_organization_mandates WHERE sponsor_wallet_address=$1', [sponsorAddress])
    await db.query('DELETE FROM trc20_token_clone.sponsor_organization_applications WHERE sponsor_wallet_address=$1', [sponsorAddress])

    await db.query(
      'INSERT INTO trc20_token_clone.sponsor_direct_applications ' +
      '(id,sponsor_address,display_name,status,per_payout_limit_base_units,daily_limit_base_units) ' +
      "VALUES ($1,$2,$3,'active',$4,$5)",
      [sponsorApplicationId, sponsorAddress, 'Integration sponsor', '50000000', '100000000'],
    )
    await db.query(
      'INSERT INTO trc20_token_clone.sponsor_organization_applications ' +
      '(id,sponsor_wallet_address,organization_name,business_email,jurisdiction,website,requested_roles,application_signature_hash,status) ' +
      "VALUES ($1,$2,$3,$4,$5,NULL,$6::jsonb,$7,'accepted-for-due-diligence')",
      [organizationApplicationId, sponsorAddress, 'Integration Sponsor LLC', 'sponsor@example.test', 'US',
        JSON.stringify(['asset-principal', 'network-fees']), 'a'.repeat(64)],
    )
    await db.query(
      'INSERT INTO trc20_token_clone.sponsor_organization_mandates ' +
      '(id,application_id,sponsor_wallet_address,agreement_reference,agreement_digest,purpose,per_payout_limit_base_units,daily_limit_base_units,valid_from,valid_until,sponsor_signature_hash,status) ' +
      "VALUES ($1,$2,$3,$4,$5,'both',$6,$7,now() - interval '1 minute',now() + interval '1 day',$8,'authorized')",
      [mandateId, organizationApplicationId, sponsorAddress, 'integration-test-agreement',
        'b'.repeat(64), '50000000', '100000000', 'c'.repeat(64)],
    )

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
    await db.query('DELETE FROM trc20_token_clone.sponsor_organization_mandates WHERE id=$1', [mandateId]).catch(() => {})
    await db.query('DELETE FROM trc20_token_clone.sponsor_organization_applications WHERE id=$1', [organizationApplicationId]).catch(() => {})
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
