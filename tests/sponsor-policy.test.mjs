import test from 'node:test'
import assert from 'node:assert/strict'
import { validateSponsorBudget, validateSponsorTransferIntent } from '../server/sponsor-policy.mjs'

const validBudget = {
  sponsorReference: 'sponsor-test',
  network: 'shasta',
  asset: 'TRX',
  budgetBaseUnits: '10000000',
  reservedBaseUnits: '2000000',
  spentBaseUnits: '3000000',
  status: 'active',
}

test('budget policy uses exact base units and computes only unreserved availability', () => {
  assert.deepEqual(validateSponsorBudget(validBudget), {
    valid: true,
    purpose: 'asset-grant',
    availableBaseUnits: '5000000',
    canReserve: true,
  })
})

test('budget policy rejects overspending, malformed precision and invalid status', () => {
  assert.equal(validateSponsorBudget({ ...validBudget, reservedBaseUnits: '8000000' }).reason, 'budget-exceeded')
  assert.equal(validateSponsorBudget({ ...validBudget, spentBaseUnits: '1.2' }).reason, 'invalid-base-units')
  assert.equal(validateSponsorBudget({ ...validBudget, status: 'active-ish' }).reason, 'invalid-budget-status')
  assert.equal(validateSponsorBudget({ ...validBudget, asset: 'TRX', tokenContract: 'TToken' }).reason, 'native-trx-has-no-token-contract')
})

test('fee and asset-grant budget purposes stay separate and fee budgets require TRX', () => {
  assert.deepEqual(validateSponsorBudget({ ...validBudget, purpose: 'network-fee' }), {
    valid: true,
    purpose: 'network-fee',
    availableBaseUnits: '5000000',
    canReserve: true,
  })
  assert.equal(validateSponsorBudget({ ...validBudget, purpose: 'network-fee', asset: 'USDT', tokenContract: 'TUsdt' }).reason, 'network-fee-must-use-trx')
  assert.equal(validateSponsorBudget({ ...validBudget, purpose: 'unknown' }).reason, 'invalid-purpose')
})

test('disabled or depleted budgets cannot be reserved from', () => {
  assert.equal(validateSponsorBudget({ ...validBudget, status: 'disabled' }).canReserve, false)
  assert.equal(validateSponsorBudget({ ...validBudget, status: 'depleted', reservedBaseUnits: '0', spentBaseUnits: '10000000' }).canReserve, false)
})

test('fee intents require TRX, valid idempotency, valid receiver and positive integer base units', () => {
  const options = { isValidAddress: (address) => address === 'TValidReceiver', maxTransferBaseUnits: '5000000' }
  const input = {
    idempotencyKey: 'request:12345678',
    sponsorReference: 'sponsor-test',
    network: 'shasta',
    purpose: 'network-fee',
    asset: 'TRX',
    receiverAddress: 'TValidReceiver',
    amountBaseUnits: '1000000',
  }
  const result = validateSponsorTransferIntent(input, options)
  assert.equal(result.valid, true)
  assert.equal(result.providerSubmissionAllowed, false)
  assert.equal(result.atomicBudgetReservationRequired, true)
  assert.equal(validateSponsorTransferIntent({ ...input, asset: 'USDT', tokenContract: 'TToken' }, options).reason, 'network-fee-must-use-trx')
  assert.equal(validateSponsorTransferIntent({ ...input, idempotencyKey: 'x' }, options).reason, 'invalid-idempotency-key')
  assert.equal(validateSponsorTransferIntent({ ...input, amountBaseUnits: '5000001' }, options).reason, 'transfer-limit-exceeded')
  assert.equal(validateSponsorTransferIntent({ ...input, amountBaseUnits: '0' }, options).reason, 'invalid-base-units')
  assert.equal(validateSponsorTransferIntent({ ...input, receiverAddress: 'bad' }, options).reason, 'invalid-receiver-address')
})

test('USDT asset grants require an explicit contract and are not treated as fee sponsorship', () => {
  const input = {
    idempotencyKey: 'request:abcdefgh',
    sponsorReference: 'sponsor-test',
    network: 'mainnet',
    purpose: 'asset-grant',
    asset: 'USDT',
    tokenContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    receiverAddress: 'TValidReceiver',
    amountBaseUnits: '1000000',
  }
  const result = validateSponsorTransferIntent(input, {
    isValidAddress: (address) => address === 'TValidReceiver',
    allowedTokenContractsByNetwork: { mainnet: ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'] },
  })
  assert.equal(result.valid, true)
  assert.equal(result.intent.purpose, 'asset-grant')
  assert.equal(result.intent.asset, 'USDT')
  assert.equal(validateSponsorTransferIntent({ ...input, tokenContract: '' }, { isValidAddress: () => true }).reason, 'token-contract-required')
  assert.equal(validateSponsorTransferIntent(input, { isValidAddress: () => true }).reason, 'official-mainnet-usdt-only')
  assert.equal(validateSponsorTransferIntent(input, {
    isValidAddress: () => true,
    allowedTokenContractsByNetwork: { shasta: ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'] },
  }).reason, 'official-mainnet-usdt-only')
  assert.equal(validateSponsorTransferIntent({ ...input, tokenContract: 'TImpostorContract' }, {
    isValidAddress: () => true,
    allowedTokenContractsByNetwork: { mainnet: ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'] },
  }).reason, 'official-mainnet-usdt-only')
})


test('independent project tokens and testnet token lookalikes are rejected for sponsor principal', () => {
  const vtrc = {
    idempotencyKey: 'request:vtrc-1234',
    sponsorReference: 'sponsor-test',
    network: 'shasta',
    purpose: 'asset-grant',
    asset: 'VTRC',
    tokenContract: 'TVtrcShastaContract',
    receiverAddress: 'TValidReceiver',
    amountBaseUnits: '2500000000000000000',
  }
  const usdtTestnet = { ...vtrc, asset: 'USDT', tokenContract: 'TTestnetUsdtContract' }
  const options = {
    isValidAddress: (address) => address === 'TValidReceiver',
    allowedTokenContractsByNetwork: {
      shasta: ['TVtrcShastaContract', 'TTestnetUsdtContract'],
    },
  }
  assert.equal(validateSponsorTransferIntent(vtrc, options).reason, 'invalid-asset')
  assert.equal(validateSponsorTransferIntent(usdtTestnet, options).reason, 'official-mainnet-usdt-only')
  assert.equal(validateSponsorBudget({ ...validBudget, asset: 'VTRC', tokenContract: 'TVtrcMainnetContract' }).reason, 'invalid-asset')
})

test('TRX fee budget remains separate from official Mainnet USDT principal', () => {
  assert.equal(validateSponsorBudget({
    ...validBudget,
    network: 'mainnet',
    asset: 'USDT',
    tokenContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  }).valid, true)
  assert.equal(validateSponsorBudget({
    ...validBudget,
    network: 'mainnet',
    asset: 'USDT',
  }).reason, 'token-contract-required')
  assert.equal(validateSponsorBudget({ ...validBudget, asset: 'TRX', tokenContract: 'TToken' }).reason, 'native-trx-has-no-token-contract')
})

