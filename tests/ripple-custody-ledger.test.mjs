import test from 'node:test'
import assert from 'node:assert/strict'
import { validateRestrictedTrxCreditAllocation } from '../server/ripple-custody-ledger.mjs'

test('restricted TRX credit allocations accept integer SUN and explicit audit/idempotency fields', () => {
  assert.equal(validateRestrictedTrxCreditAllocation({
    customerId: 'customer-1', amountSun: '100000000', idempotencyKey: 'credit-2026-001', reason: 'Admin restricted credit',
  }).valid, true)
})

test('restricted credit ledger rejects floats, zero, exponent notation, bad keys and missing reasons', () => {
  for (const amountSun of ['0', '1.5', '1e6', '-1', '01', '']) {
    assert.equal(validateRestrictedTrxCreditAllocation({
      customerId: 'customer-1', amountSun, idempotencyKey: 'credit-2026-001', reason: 'Admin credit',
    }).valid, false)
  }
  assert.equal(validateRestrictedTrxCreditAllocation({ customerId: 'customer-1', amountSun: '1', idempotencyKey: 'short', reason: 'Admin credit' }).valid, false)
  assert.equal(validateRestrictedTrxCreditAllocation({ customerId: 'customer-1', amountSun: '1', idempotencyKey: 'credit-2026-001', reason: '' }).valid, false)
})
