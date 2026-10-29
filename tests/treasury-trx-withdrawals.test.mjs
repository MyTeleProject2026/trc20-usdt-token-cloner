import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import {
  buildTreasuryTrxWithdrawalAuthorizationMessage,
} from '../src/treasury-withdrawal-auth.mjs'
import {
  createTreasuryWithdrawalsRouter,
  matchesTreasuryTrxWithdrawalRequest,
  verifyTreasuryTrxTransferEvidence,
} from '../server/routes/treasury-withdrawals.mjs'

const ownerAddress = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
const treasuryAddress = 'TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax'
const recipientAddress = 'TLPsmx7qvAq5QGJSYxCBkXb6j9bQvVQ3yP'
const idempotencyKey = 'trx-withdrawal-12345678-1234-4123-8123-123456789abc'

test('TRX withdrawal request matching binds owner, treasury, recipient and amount', () => {
  const row = {
    owner_address: ownerAddress,
    treasury_address: treasuryAddress,
    recipient_address: recipientAddress,
    amount_base_units: '1234567',
  }
  const request = { ownerAddress, treasuryAddress, recipientAddress, amountBaseUnits: '1234567' }
  assert.equal(matchesTreasuryTrxWithdrawalRequest(row, request), true)
  assert.equal(matchesTreasuryTrxWithdrawalRequest(row, { ...request, amountBaseUnits: '1234568' }), false)
  assert.equal(matchesTreasuryTrxWithdrawalRequest(row, { ...request, recipientAddress: treasuryAddress }), false)
})

test('TRX native transfer verifier confirms only exact sender, recipient, amount, and confirmed block', () => {
  const hex = {
    [ownerAddress]: '41' + '11'.repeat(20),
    [treasuryAddress]: '41' + '22'.repeat(20),
    [recipientAddress]: '41' + '33'.repeat(20),
  }
  const txid = 'a'.repeat(64)
  const tronWeb = { address: { toHex: (address) => hex[address] || '' } }
  const transaction = {
    txID: txid,
    raw_data: { contract: [{
      type: 'TransferContract',
      parameter: { value: {
        owner_address: hex[treasuryAddress],
        to_address: hex[recipientAddress],
        amount: 1234567,
      } },
    }] },
  }
  const transactionInfo = { id: txid, blockNumber: 123 }
  const options = { transaction, transactionInfo, transactionHash: txid, treasuryAddress, recipientAddress, amountBaseUnits: '1234567' }
  assert.deepEqual(verifyTreasuryTrxTransferEvidence(tronWeb, options), {
    verified: true, status: 'confirmed', reason: 'confirmed-solidified-native-transfer-intent', blockNumber: 123,
  })
  assert.equal(verifyTreasuryTrxTransferEvidence(tronWeb, { ...options, amountBaseUnits: '7654321' }).status, 'verification-mismatch')
  assert.equal(verifyTreasuryTrxTransferEvidence(tronWeb, { ...options, recipientAddress: ownerAddress }).status, 'verification-mismatch')
  assert.equal(verifyTreasuryTrxTransferEvidence(tronWeb, { ...options, transactionInfo: { id: txid, blockNumber: 0 } }).status, 'awaiting-confirmed-receipt')
})

test('TRX native transfer verifier treats an explicit failed result as failed after confirming request intent', () => {
  const hex = {
    [treasuryAddress]: '41' + '22'.repeat(20),
    [recipientAddress]: '41' + '33'.repeat(20),
  }
  const txid = 'b'.repeat(64)
  const tronWeb = { address: { toHex: (address) => hex[address] || '' } }
  const transaction = {
    txID: txid,
    ret: [{ contractRet: 'REVERT' }],
    raw_data: { contract: [{
      type: 'TransferContract',
      parameter: { value: { owner_address: hex[treasuryAddress], to_address: hex[recipientAddress], amount: 5000000 } },
    }] },
  }
  const result = verifyTreasuryTrxTransferEvidence(tronWeb, {
    transaction, transactionInfo: { id: txid, blockNumber: 456 }, transactionHash: txid,
    treasuryAddress, recipientAddress, amountBaseUnits: '5000000',
  })
  assert.equal(result.verified, true)
  assert.equal(result.status, 'failed')
})

test('TRX withdrawal authorization rejects a non TRX amount, an invalid recipient and a malformed request key', () => {
  const base = { origin:'https://owner.example', ownerAddress, treasuryAddress, recipientAddress,
    amountBaseUnits:'1230000', idempotencyKey, authorizationExpiresAt:1_800_000_000_000 }
  const message = buildTreasuryTrxWithdrawalAuthorizationMessage(base)
  assert.match(message, /Asset: TRX/)
  assert.match(message, /Amount base units \(sun\): 1230000/)
  assert.throws(() => buildTreasuryTrxWithdrawalAuthorizationMessage({ ...base, recipientAddress:'T' }))
  assert.throws(() => buildTreasuryTrxWithdrawalAuthorizationMessage({ ...base, amountBaseUnits:'0' }))
  assert.throws(() => buildTreasuryTrxWithdrawalAuthorizationMessage({ ...base, idempotencyKey:'short' }))
})


const managedTrxOwnerEnv = {
  OWNER_WALLET_ADDRESS: ownerAddress,
  TREASURY_OWNER_ADDRESS: ownerAddress,
  TREASURY_ADDRESS: treasuryAddress,
  TREASURY_TRX_WITHDRAWALS_ENABLED: 'false',
  TREASURY_SIGNER_MODE: 'fireblocks',
}

function createOwnerSessionApp(env = managedTrxOwnerEnv) {
  const app = express()
  app.use(express.json())
  app.use('/api/treasury', createTreasuryWithdrawalsRouter({
    env,
    sessionLookup: async ({ origin }) => ({
      success: true,
      session: { network: 'mainnet', address: ownerAddress, origin },
    }),
  }))
  return app
}

test('managed native-TRX readiness is fail-closed when Fireblocks credentials, vault asset and database are not configured', async (t) => {
  const server = createServer(createOwnerSessionApp())
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const address = server.address()
  const response = await fetch(`http://127.0.0.1:${address.port}/api/treasury/trx-withdrawals/readiness`, {
    headers: {
      origin: 'https://owner.example',
      authorization: 'Bearer ' + 'a'.repeat(43),
    },
  })
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.success, true)
  assert.equal(payload.trxWithdrawalsEnabled, false)
  assert.equal(payload.withdrawalsEnabled, false)
  assert.ok(payload.payoutBlockers.includes('trx-payout-feature-disabled'))
  assert.ok(payload.payoutBlockers.includes('database-not-ready'))
  assert.equal(payload.configuration.signerMode, 'fireblocks-managed')
  assert.equal(payload.configuration.providerConfigured, false)
})

test('managed native-TRX submission remains disabled and cannot call the provider without reviewed configuration', async (t) => {
  let providerSubmissionCalled = false
  const server = createServer((() => {
    const app = createOwnerSessionApp()
    return app
  })())
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const address = server.address()
  const response = await fetch(`http://127.0.0.1:${address.port}/api/treasury/trx-withdrawals`, {
    method: 'POST',
    headers: {
      origin: 'https://owner.example',
      authorization: 'Bearer ' + 'a'.repeat(43),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      recipientAddress,
      amountTrx: '1',
      idempotencyKey,
      ownerAuthorizationSignature: '0x' + 'a'.repeat(130),
      authorizationExpiresAt: Date.now() + 60_000,
    }),
  })
  const payload = await response.json()
  assert.equal(response.status, 503)
  assert.equal(payload.error, 'treasury-trx-withdrawals-disabled')
  assert.equal(providerSubmissionCalled, false)
})

test('managed TRX source no longer depends on a treasury blockchain private-key environment variable', async () => {
  const source = (await import('node:fs/promises')).readFile
  const { readFile } = await import('node:fs/promises')
  const routeSource = await readFile(new URL('../server/routes/treasury-withdrawals.mjs', import.meta.url), 'utf8')
  const trxStart = routeSource.indexOf("router.get('/trx-withdrawals/readiness'")
  const trxEnd = routeSource.indexOf("  return router", trxStart)
  assert.ok(trxStart > 0 && trxEnd > trxStart)
  const trxRoute = routeSource.slice(trxStart, trxEnd)
  assert.match(trxRoute, /provider\.createTrxTransfer/)
  assert.match(trxRoute, /provider\.getTransaction|refreshManagedTrxProviderTransaction/)
  assert.doesNotMatch(trxRoute, /TREASURY_PRIVATE_KEY/)
})
