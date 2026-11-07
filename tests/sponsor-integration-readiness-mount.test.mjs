import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('server mounts the sponsor integration-readiness router under the public TRON API prefix', async () => {
  const source = await readFile(new URL('../server/index.mjs', import.meta.url), 'utf8')
  assert.match(source, /import \{ createSponsorIntegrationReadinessRouter \} from '\.\/routes\/sponsor-integration-readiness\.mjs'/)
  assert.match(source, /app\.use\('\/api\/tron', createSponsorIntegrationReadinessRouter\(\)\)/)
})


test('server mounts organizational sponsor onboarding routes without enabling payouts', async () => {
  const source = await readFile(new URL('../server/index.mjs', import.meta.url), 'utf8')
  assert.match(source, /import \{ createSponsorOrganizationRouter \} from '\.\/routes\/sponsor-organization-onboarding\.mjs'/)
  assert.match(source, /app\.use\('\/api\/tron', createSponsorOrganizationRouter\(\)\)/)
  assert.match(source, /Organizational sponsor onboarding is governance-only/)
})
