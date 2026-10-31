import test from 'node:test'
import assert from 'node:assert/strict'
import { matchesFireblocksInventoryBearer } from '../server/routes/fireblocks-inventory-sync.mjs'

test('Fireblocks inventory trigger requires exact long bearer secret', () => {
  const secret = 'test-only-inventory-trigger-secret-0123456789'
  assert.equal(matchesFireblocksInventoryBearer('Bearer ' + secret, secret), true)
  assert.equal(matchesFireblocksInventoryBearer('Bearer ' + secret, secret + 'x'), false)
  assert.equal(matchesFireblocksInventoryBearer('Bearer short', secret), false)
  assert.equal(matchesFireblocksInventoryBearer('Basic ' + secret, secret), false)
  assert.equal(matchesFireblocksInventoryBearer('Bearer ' + secret, ''), false)
})

