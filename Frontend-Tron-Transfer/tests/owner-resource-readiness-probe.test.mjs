import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('production Owner resource probe reads the Resource API nested snapshot schema', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/tron-transfer-production-uptime.yml', import.meta.url), 'utf8')
  assert.ok(workflow.includes('parsed?.energy?.available'))
  assert.ok(workflow.includes('parsed?.bandwidth?.freeAvailable'))
  assert.ok(workflow.includes('parsed?.bandwidth?.stakedOrDelegatedAvailable'))
  assert.ok(workflow.includes('parsed?.rpc?.providersUsed'))
  assert.ok(workflow.includes('/v1/resources/TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'))
  assert.equal(workflow.includes('parsed?.energyAvailable'), false)
  assert.equal(workflow.includes('parsed?.freeBandwidthAvailable'), false)
})

test('production push probe verifies Retry-After and CORS header exposure', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/tron-transfer-production-uptime.yml', import.meta.url), 'utf8')
  assert.ok(workflow.includes('Verify production Retry-After and CORS response headers'))
  assert.ok(workflow.includes("limited.headers.get('retry-after')"))
  assert.ok(workflow.includes("limited.headers.get('access-control-expose-headers')"))
  assert.ok(workflow.includes("if: github.event_name == 'push' || github.event_name == 'workflow_dispatch'"))
})
