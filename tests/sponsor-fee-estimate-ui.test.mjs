import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const ui = await readFile(new URL('../src/WorkflowApp.tsx', import.meta.url), 'utf8')
const entry = await readFile(new URL('../server/index.mjs', import.meta.url), 'utf8')
const route = await readFile(new URL('../server/routes/sponsor-fee-estimate.mjs', import.meta.url), 'utf8')

test('read-only sponsor energy estimate is mounted and wired to the exact request parameters', () => {
  assert.ok(entry.includes("import sponsorFeeEstimateRoutes from './routes/sponsor-fee-estimate.mjs'"))
  assert.ok(entry.includes("app.use('/api/tron', sponsorFeeEstimateRoutes)"))
  assert.ok(ui.includes('/api/tron/sponsorship/fee-estimate'))
  assert.ok(ui.includes('tokenContract: contract'))
  assert.ok(ui.includes('receiverAddress: receiver'))
  assert.ok(ui.includes('amountBaseUnits: exactAmountBaseUnits'))
  assert.ok(ui.includes('current-node simulation'))
  assert.ok(ui.includes('Estimate sponsor energy'))
  assert.ok(ui.includes('Estimated Energy required'))
})

test('fee estimate UI invalidates stale results when exact request fields change', () => {
  assert.ok(ui.includes('feeEstimateRequestGeneration'))
  assert.ok(ui.includes('clearFeeEstimate()'))
  const handlerStart = ui.indexOf('  const estimateSponsoredFee = async () => {')
  const handlerEnd = ui.indexOf('  const inspectReceiver = async () => {', handlerStart)
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart)
  const handler = ui.slice(handlerStart, handlerEnd)
  assert.ok(handler.includes('requestGeneration !== feeEstimateRequestGeneration.current'))
  assert.ok(handler.includes('exactAmountBaseUnits !== payload.amountBaseUnits'))
})

test('estimator cannot activate sponsored submission and does not count undelegated fee resources', () => {
  assert.ok(route.includes('canSubmitSponsoredTransfer: false'))
  assert.ok(route.includes('submissionEnabled: false'))
  assert.ok(route.includes('transactionBroadcast: false'))
  assert.ok(route.includes('feeSponsorResourcesCountedTowardPrincipalTransfer: false'))
  assert.ok(route.includes('resourceDelegationVerified: false'))
  assert.ok(route.includes('totalNetworkFeeEstimated: false'))
  assert.ok(route.includes('provider-signing-and-broadcast-adapter-disabled'))
  assert.ok(ui.includes('Bandwidth / total network fee'))
  assert.ok(ui.includes('Not yet estimated'))
  assert.ok(ui.includes('Verified delegation'))
})
