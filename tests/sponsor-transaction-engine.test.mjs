import test from 'node:test'
import assert from 'node:assert/strict'
import { createSponsorTransactionEngine } from '../server/sponsor-transaction-engine.mjs'

const sponsor = 'TQ8r4gM6y2sW9nK3pL7vX5aB1cD8eF4gHj'
const owner = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'

test('Sponsor transaction engine is hard-disabled unless both Mainnet execution flags are true', async () => {
  const engine = createSponsorTransactionEngine({ env: { SPONSOR_MAINNET_PRIVATE_KEY: 'a'.repeat(64), SPONSOR_MAINNET_ADDRESS: sponsor } })
  const result = await engine.execute({ operation: 'stake', amountSun: '1000000', resource: 'ENERGY', ownerAddress: owner, confirmPhrase: 'CONFIRM TRON MAINNET SPONSOR TRANSACTION' })
  assert.equal(result.status, 'sponsor-transaction-engine-disabled')
  assert.equal(result.signed, false)
  assert.equal(result.broadcast, false)
})

test('Sponsor transaction engine rejects missing per-operation confirmation before signer access', async () => {
  let signerCreated = false
  const env = { SPONSOR_TRANSACTION_ENGINE_ENABLED: 'true', SPONSOR_MAINNET_BROADCAST_ENABLED: 'true' }
  const engine = createSponsorTransactionEngine({ env, tronWebFactory: () => { signerCreated = true; throw new Error('must-not-run') } })
  const result = await engine.execute({ operation: 'delegate', amountSun: '1000000', resource: 'ENERGY', ownerAddress: owner })
  assert.equal(result.status, 'invalid-or-unconfirmed-mainnet-intent')
  assert.equal(signerCreated, false)
})

test('Sponsor transaction engine rejects malformed amount and unsupported operation', async () => {
  const env = { SPONSOR_TRANSACTION_ENGINE_ENABLED: 'true', SPONSOR_MAINNET_BROADCAST_ENABLED: 'true' }
  const engine = createSponsorTransactionEngine({ env })
  const invalidAmount = await engine.execute({ operation: 'stake', amountSun: '1.2', resource: 'ENERGY', ownerAddress: owner, confirmPhrase: 'CONFIRM TRON MAINNET SPONSOR TRANSACTION' })
  const invalidOperation = await engine.execute({ operation: 'unstake', amountSun: '1000000', resource: 'ENERGY', ownerAddress: owner, confirmPhrase: 'CONFIRM TRON MAINNET SPONSOR TRANSACTION' })
  assert.equal(invalidAmount.status, 'invalid-amount-sun')
  assert.equal(invalidOperation.status, 'invalid-or-unconfirmed-mainnet-intent')
})

test('Sponsor transaction engine never accepts Sponsor and Owner identity collision', async () => {
  const env = { SPONSOR_TRANSACTION_ENGINE_ENABLED: 'true', SPONSOR_MAINNET_BROADCAST_ENABLED: 'true', SPONSOR_MAINNET_PRIVATE_KEY: 'a'.repeat(64), SPONSOR_MAINNET_ADDRESS: owner }
  const engine = createSponsorTransactionEngine({ env, tronWebFactory: () => ({ address: { fromPrivateKey: () => owner } }) })
  const result = await engine.execute({ operation: 'stake', amountSun: '1000000', resource: 'ENERGY', ownerAddress: owner, confirmPhrase: 'CONFIRM TRON MAINNET SPONSOR TRANSACTION' })
  assert.equal(result.status, 'sponsor-owner-wallets-must-be-independent')
  assert.equal(result.signed, false)
  assert.equal(result.broadcast, false)
})
