import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { createSponsorSettlementRouter } from '../server/routes/sponsor-settlement.mjs'

const adminToken = 'administrator-token-for-tests-only-0123456789'
const sponsorAddress = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
const receiverAddress = 'TTGhREx2pDSxFX555NWz1YwGpiBVPvQA7e'
const contractAddress = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const txid = 'a'.repeat(64)
const idempotencyKey = 'sponsor-pilot-settlement-test-0001'

function validTransfer(overrides = {}) {
  return {
    idempotencyKey,
    sponsorReference: 'pilot-principal',
    sponsorAddress,
    network: 'nile',
    purpose: 'asset-grant',
    asset: 'USDT',
    tokenContract: contractAddress,
    receiverAddress,
    amountBaseUnits: '2500000',
    status: 'submitted',
    transactionHash: txid,
    budgetStatus: 'active',
    budgetApproved: true,
    ...overrides,
  }
}

async function listenRouter(t, dependencies = {}) {
  const app = express()
  app.use(express.json())
  app.use('/api/tron', createSponsorSettlementRouter({
    env: { SPONSOR_ADMIN_API_TOKEN: adminToken },
    lookupTransfer: async () => ({ success: true, transfer: validTransfer() }),
    confirmTransfer: async () => ({ updated: true, duplicate: false, status: 'confirmed' }),
    ...dependencies,
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return `http://127.0.0.1:${server.address().port}/api/tron/sponsorship/transfers/${idempotencyKey}/confirm`
}

function adminHeaders() {
  return { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }
}

test('settlement endpoint requires a configured server-only administrator token', async (t) => {
  let lookupCalled = false
  const app = express()
  app.use('/api/tron', createSponsorSettlementRouter({
    env: {},
    lookupTransfer: async () => { lookupCalled = true; return { success: true, transfer: validTransfer() } },
    confirmTransfer: async () => { throw new Error('must-not-run') },
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/api/tron/sponsorship/transfers/${idempotencyKey}/confirm`
  const response = await fetch(url, { method: 'POST' })
  const payload = await response.json()
  assert.equal(response.status, 503)
  assert.equal(payload.error, 'sponsor-admin-not-configured')
  assert.equal(payload.submissionEnabled, false)
  assert.equal(lookupCalled, false)
})

test('settlement endpoint rejects unauthorized callers without looking up a transfer', async (t) => {
  let lookupCalled = false
  const url = await listenRouter(t, {
    lookupTransfer: async () => { lookupCalled = true; return { success: true, transfer: validTransfer() } },
  })
  const response = await fetch(url, { method: 'POST' })
  const payload = await response.json()
  assert.equal(response.status, 401)
  assert.equal(payload.error, 'unauthorized')
  assert.equal(payload.submissionEnabled, false)
  assert.equal(lookupCalled, false)
})

test('settlement endpoint refuses a caller-supplied transaction hash that differs from the stored hash', async (t) => {
  let confirmCalled = false
  const url = await listenRouter(t, {
    confirmTransfer: async () => { confirmCalled = true; return { updated: true } },
  })
  const response = await fetch(url, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ transactionHash: 'b'.repeat(64) }),
  })
  const payload = await response.json()
  assert.equal(response.status, 409)
  assert.equal(payload.error, 'transaction-hash-conflict')
  assert.equal(payload.submissionEnabled, false)
  assert.equal(confirmCalled, false)
})

test('settlement endpoint will not confirm Mainnet or network-fee budget rows', async (t) => {
  for (const overrides of [{ network: 'mainnet' }, { purpose: 'network-fee', asset: 'TRX', tokenContract: null }]) {
    let confirmCalled = false
    const url = await listenRouter(t, {
      lookupTransfer: async () => ({ success: true, transfer: validTransfer(overrides) }),
      confirmTransfer: async () => { confirmCalled = true; return { updated: true } },
    })
    const response = await fetch(url, { method: 'POST', headers: adminHeaders(), body: '{}' })
    const payload = await response.json()
    assert.equal(response.status, 409)
    assert.equal(payload.submissionEnabled, false)
    assert.equal(confirmCalled, false)
  }
})

test('settlement endpoint asks for exact chain verification when persisted evidence is missing', async (t) => {
  let calledWith
  const url = await listenRouter(t, {
    confirmTransfer: async (value) => {
      calledWith = value
      return { updated: false, reason: 'finalized-transfer-evidence-not-found' }
    },
  })
  const response = await fetch(url, { method: 'POST', headers: adminHeaders(), body: '{}' })
  const payload = await response.json()
  assert.equal(response.status, 409)
  assert.equal(payload.error, 'finalized-transfer-evidence-not-found')
  assert.equal(payload.verificationRequired.method, 'GET')
  assert.match(payload.verificationRequired.path, /^\/api\/tron\/verify-trc20-transfer\//)
  assert.match(payload.verificationRequired.path, /network=nile/)
  assert.match(payload.verificationRequired.path, /amountBaseUnits=2500000/)
  assert.equal(calledWith.idempotencyKey, idempotencyKey)
  assert.equal(calledWith.nextStatus, 'confirmed')
  assert.equal(calledWith.transactionHash, txid)
  assert.equal(payload.submissionEnabled, false)
})

test('settlement endpoint confirms from the stored transaction and provides a separate receiver-balance check', async (t) => {
  let calledWith
  const url = await listenRouter(t, {
    confirmTransfer: async (value) => {
      calledWith = value
      return { updated: true, duplicate: false, status: 'confirmed' }
    },
  })
  const response = await fetch(url, { method: 'POST', headers: adminHeaders(), body: '{}' })
  const payload = await response.json()
  assert.equal(response.status, 200)
  assert.equal(payload.success, true)
  assert.equal(payload.status, 'ledger-confirmed-from-solidified-evidence')
  assert.equal(payload.ledger.status, 'confirmed')
  assert.equal(payload.ledger.principalSpendRecorded, true)
  assert.equal(payload.receiverBalance.status, 'read-separately')
  assert.match(payload.receiverBalance.path, /^\/api\/tron\/token-balance\?/)
  assert.equal(payload.submissionEnabled, false)
  assert.equal(payload.unpaidFallbackToUserFunds, false)
  assert.equal(calledWith.nextStatus, 'confirmed')
  assert.equal(calledWith.transactionHash, txid)
  assert.equal(JSON.stringify(payload).includes(adminToken), false)
})

test('settlement endpoint uses the native TRX verifier and balance route for a TRX grant', async (t) => {
  const url = await listenRouter(t, {
    lookupTransfer: async () => ({
      success: true,
      transfer: validTransfer({ asset: 'TRX', tokenContract: null, amountBaseUnits: '1500000' }),
    }),
    confirmTransfer: async () => ({ updated: false, reason: 'finalized-transfer-evidence-not-found' }),
  })
  const response = await fetch(url, { method: 'POST', headers: adminHeaders(), body: '{}' })
  const payload = await response.json()
  assert.equal(response.status, 409)
  assert.match(payload.verificationRequired.path, /^\/api\/tron\/verify-native-transfer\//)
  assert.match(payload.verificationRequired.path, /amountSun=1500000/)
})

test('settlement endpoint rejects unexpected fields and never accepts a client success flag', async (t) => {
  let confirmCalled = false
  const url = await listenRouter(t, {
    confirmTransfer: async () => { confirmCalled = true; return { updated: true } },
  })
  const response = await fetch(url, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ verified: true, status: 'confirmed', transactionHash: txid }),
  })
  const payload = await response.json()
  assert.equal(response.status, 400)
  assert.equal(payload.error, 'unexpected-fields')
  assert.equal(confirmCalled, false)
})
