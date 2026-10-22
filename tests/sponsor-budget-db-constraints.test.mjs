import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { validateSponsorBudget, validateSponsorTransferIntent } from '../server/sponsor-policy.mjs'

test('sponsor budget database constraint enforces TRX-only network-fee budgets', async () => {
  const source = await readFile(new URL('../server/database.mjs', import.meta.url), 'utf8')
  assert.match(source, /sponsor_budgets_network_fee_requires_trx/)
  assert.match(source, /CHECK \\(purpose <> 'network-fee' OR asset = 'TRX'\\\) NOT VALID/)
  assert.match(source, /conrelid = '\$\{schema\}\.sponsor_budgets'::regclass/)
})

test('fee-purpose policy rejects token principal for budgets and transfer intents', () => {
  const base = {
    sponsorReference: 'external-sponsor-test',
    network: 'shasta',
    purpose: 'network-fee',
    asset: 'TRX',
    tokenContract: null,
    budgetBaseUnits: '100',
    reservedBaseUnits: '0',
    spentBaseUnits: '0',
    status: 'disabled',
  }
  assert.equal(validateSponsorBudget(base).valid, true)
  assert.equal(validateSponsorBudget({ ...base, asset: 'USDT', tokenContract: 'TContract' }).reason, 'network-fee-must-use-trx')
  assert.equal(validateSponsorBudget({ ...base, asset: 'VTRC', tokenContract: 'TVtrc' }).reason, 'network-fee-must-use-trx')

  const intent = {
    idempotencyKey: 'fee-policy-test-0001',
    sponsorReference: 'external-sponsor-test',
    network: 'shasta',
    purpose: 'network-fee',
    asset: 'TRX',
    receiverAddress: 'TReceiver',
    amountBaseUnits: '10',
  }
  assert.equal(validateSponsorTransferIntent(intent, { isValidAddress: () => true }).valid, true)
  assert.equal(validateSponsorTransferIntent({ ...intent, asset: 'USDT', tokenContract: 'TContract' }, {
    isValidAddress: () => true,
    allowedTokenContractsByNetwork: { shasta: ['TContract'] },
  }).reason, 'network-fee-must-use-trx')
})
