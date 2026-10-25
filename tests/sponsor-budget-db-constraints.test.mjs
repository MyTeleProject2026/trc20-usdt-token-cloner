import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { validateSponsorBudget, validateSponsorTransferIntent } from '../server/sponsor-policy.mjs'
import { createSponsorBudgetDraft, listSponsorBudgets, listSponsorTransfers, activateSponsorBudget, isSponsorAgreementReferenceConfigured, isApprovedSponsorAgreementScope } from '../server/database.mjs'

test('sponsor budget database constraint enforces TRX-only network-fee budgets', async () => {
  const source = await readFile(new URL('../server/database.mjs', import.meta.url), 'utf8')
  assert.match(source, /sponsor_budgets_network_fee_requires_trx/)
  assert.ok(source.includes("CHECK (purpose <> 'network-fee' OR asset = 'TRX') NOT VALID"))
  assert.ok(source.includes('DO $sponsor_fee_budget$ BEGIN'))
  assert.ok(source.includes("ADD CONSTRAINT sponsor_budgets_network_fee_requires_trx"))
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

test('sponsor transfer database constraint prevents fee operations from being token-principal transfers', async () => {
  const source = await readFile(new URL('../server/database.mjs', import.meta.url), 'utf8')
  assert.match(source, /sponsor_transfers_network_fee_requires_trx/)
  assert.ok(source.includes("ADD CONSTRAINT sponsor_transfers_network_fee_requires_trx"))
  assert.ok(source.includes("CHECK (purpose <> 'network-fee' OR asset = 'TRX') NOT VALID"))
  assert.ok(source.includes("ADD CONSTRAINT sponsor_transfers_network_fee_requires_trx"))
  assert.ok(source.includes('DO $sponsor_transfer_fee$ BEGIN'))
})
test('sponsor budget and transfer records enforce native-vs-token contract shape', async () => {
  const source = await readFile(new URL('../server/database.mjs', import.meta.url), 'utf8')
  assert.match(source, /sponsor_budgets_asset_contract_shape/)
  assert.match(source, /sponsor_transfers_asset_contract_shape/)
  assert.ok(source.includes("asset = 'TRX' AND token_contract IS NULL"))
  assert.ok(source.includes("asset IN ('USDT','VTRC') AND token_contract IS NOT NULL AND length(btrim(token_contract)) > 0"))
  assert.ok(source.includes('DO $sponsor_budget_contract$ BEGIN'))
  assert.ok(source.includes('DO $sponsor_transfer_contract$ BEGIN'))
})


test('operator sponsor budget draft validator rejects fee/token and amount mismatches before database access', async () => {
  const base = {
    network: 'shasta',
    sponsorReference: 'sponsor-draft-test',
    purpose: 'network-fee',
    asset: 'TRX',
    tokenContract: null,
    budgetBaseUnits: '1000000',
    sponsorAddress: 'T' + 'A'.repeat(33),
  }
  assert.deepEqual(await createSponsorBudgetDraft({ ...base, network: 'attacker' }), {
    success: false, reason: 'invalid-budget-draft',
  })
  assert.deepEqual(await createSponsorBudgetDraft({ ...base, asset: 'USDT', tokenContract: 'T' + 'B'.repeat(33) }), {
    success: false, reason: 'invalid-budget-draft',
  })
  assert.deepEqual(await createSponsorBudgetDraft({ ...base, budgetBaseUnits: '0' }), {
    success: false, reason: 'invalid-budget-draft',
  })
  assert.deepEqual(await createSponsorBudgetDraft({ ...base, sponsorAddress: 'not-an-address' }), {
    success: false, reason: 'invalid-budget-draft',
  })
})

test('sponsor budget ledger listing rejects invalid query bounds before database access', async () => {
  assert.deepEqual(await listSponsorBudgets({ network: 'attacker' }), {
    success: false, reason: 'invalid-network', budgets: [],
  })
  assert.deepEqual(await listSponsorBudgets({ limit: 101 }), {
    success: false, reason: 'invalid-limit', budgets: [],
  })
  assert.deepEqual(await listSponsorBudgets({ sponsorAddress: 'not-an-address' }), {
    success: false, reason: 'invalid-sponsor-address', budgets: [],
  })
})


test('sponsor budget activation requires allowlisted agreement and fresh evidence before database access', async () => {
  const previous = process.env.SPONSOR_APPROVED_AGREEMENT_REFERENCES
  process.env.SPONSOR_APPROVED_AGREEMENT_REFERENCES = 'signed-agreement-approved|sponsor-draft-test|shasta|TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2|network-fee|TRX|-'
  try {
    assert.equal(isSponsorAgreementReferenceConfigured('signed-agreement-approved'), true)
    assert.equal(isSponsorAgreementReferenceConfigured('signed-agreement-not-approved'), false)

    const budgetScope = {
      sponsor_reference: 'sponsor-draft-test',
      network: 'shasta',
      sponsor_address: 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2',
      purpose: 'network-fee',
      asset: 'TRX',
      token_contract: null,
    }
    assert.equal(isApprovedSponsorAgreementScope({ consentReference: 'signed-agreement-approved', budget: budgetScope }), true)
    assert.equal(isApprovedSponsorAgreementScope({ consentReference: 'signed-agreement-approved', budget: { ...budgetScope, purpose: 'asset-grant' } }), false)

    const unapproved = await activateSponsorBudget({
      budgetId: '1',
      consentReference: 'signed-agreement-not-approved',
      reviewReference: 'review-ticket-123',
      fundingSnapshot: {},
    })
    assert.deepEqual(unapproved, { success: false, reason: 'agreement-reference-not-approved' })

    const snapshotMissing = await activateSponsorBudget({
      budgetId: '1',
      consentReference: 'signed-agreement-approved',
      reviewReference: 'review-ticket-123',
      fundingSnapshot: {},
    })
    assert.deepEqual(snapshotMissing, { success: false, reason: 'fresh-solidified-funding-snapshot-required' })
  } finally {
    if (previous === undefined) delete process.env.SPONSOR_APPROVED_AGREEMENT_REFERENCES
    else process.env.SPONSOR_APPROVED_AGREEMENT_REFERENCES = previous
  }
})


test('sponsor agreement scopes reject wrong-network tokens and pin Mainnet USDT', () => {
  const keys = [
    'SPONSOR_APPROVED_AGREEMENT_REFERENCES',
    'SPONSOR_USDT_SHASTA_CONTRACTS',
    'SPONSOR_USDT_MAINNET_CONTRACTS',
  ]
  const previous = new Map(keys.map((key) => [key, process.env[key]]))
  const sponsorAddress = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'
  const tokenAddress = 'T' + 'B'.repeat(33)
  const officialMainnetUsdt = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
  try {
    process.env.SPONSOR_USDT_SHASTA_CONTRACTS = tokenAddress
    process.env.SPONSOR_USDT_MAINNET_CONTRACTS = tokenAddress
    process.env.SPONSOR_APPROVED_AGREEMENT_REFERENCES = [
      `signed-shasta-usdt|sponsor-usdt-shasta|shasta|${sponsorAddress}|asset-grant|USDT|${tokenAddress}`,
      `wrong-mainnet-usdt|sponsor-usdt-mainnet|mainnet|${sponsorAddress}|asset-grant|USDT|${tokenAddress}`,
      `fee-purpose-token|sponsor-usdt-shasta|shasta|${sponsorAddress}|network-fee|USDT|${tokenAddress}`,
      `signed-mainnet-usdt|sponsor-usdt-mainnet|mainnet|${sponsorAddress}|asset-grant|USDT|${officialMainnetUsdt}`,
    ].join(';')

    assert.equal(isSponsorAgreementReferenceConfigured('signed-shasta-usdt'), true)
    assert.equal(isSponsorAgreementReferenceConfigured('wrong-mainnet-usdt'), false)
    assert.equal(isSponsorAgreementReferenceConfigured('fee-purpose-token'), false)
    assert.equal(isSponsorAgreementReferenceConfigured('signed-mainnet-usdt'), true)
    assert.equal(isSponsorAgreementReferenceConfigured('malformed reference with spaces'), false)

    const shastaBudget = {
      sponsor_reference: 'sponsor-usdt-shasta',
      network: 'shasta',
      sponsor_address: sponsorAddress,
      purpose: 'asset-grant',
      asset: 'USDT',
      token_contract: tokenAddress,
    }
    assert.equal(isApprovedSponsorAgreementScope({
      consentReference: 'signed-shasta-usdt',
      budget: shastaBudget,
    }), true)
    assert.equal(isApprovedSponsorAgreementScope({
      consentReference: 'signed-shasta-usdt',
      budget: { ...shastaBudget, network: 'mainnet' },
    }), false)
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})


test('sponsor transfer listing rejects invalid filters before database access', async () => {
  assert.deepEqual(await listSponsorTransfers({ network: 'attacker' }), {
    success: false, reason: 'invalid-network', transfers: [],
  })
  assert.deepEqual(await listSponsorTransfers({ status: 'broadcast' }), {
    success: false, reason: 'invalid-status', transfers: [],
  })
  assert.deepEqual(await listSponsorTransfers({ sponsorReference: 'bad reference with spaces' }), {
    success: false, reason: 'invalid-sponsor-reference', transfers: [],
  })
  assert.deepEqual(await listSponsorTransfers({ limit: 101 }), {
    success: false, reason: 'invalid-limit', transfers: [],
  })
})
