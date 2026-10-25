import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/SponsorSignerConsole.tsx', import.meta.url), 'utf8')
const cli = await readFile(new URL('../scripts/reconcile-sponsor-transfer.mjs', import.meta.url), 'utf8')

test('operator UI offers secure terminal reconciliation only for a validated stored-intent key', () => {
  assert.ok(source.includes('const copyReconciliationCommand = async () =>'))
  assert.ok(source.includes('/^[A-Za-z0-9._:-]{24,160}$/.test(key)'))
  assert.ok(source.includes('npm run sponsor:reconcile --'))
  assert.ok(cli.includes('/reconcile-solidified'))
  assert.ok(source.includes('Run it in a trusted checkout terminal where SPONSOR_ADMIN_API_TOKEN is already set; do not put the token in this page or source control.'))
  assert.ok(source.includes('The copied command contains no admin token.'))
})

test('frontend reconciliation helper never reads or embeds an admin token', () => {
  const helperStart = source.indexOf('const copyReconciliationCommand = async () =>')
  const helperEnd = source.indexOf('const globalProductionEnabled', helperStart)
  const helper = source.slice(helperStart, helperEnd)
  assert.ok(helperStart >= 0 && helperEnd > helperStart)
  assert.ok(!/SPONSOR_ADMIN_API_TOKEN\s*[:=]/.test(helper))
  assert.ok(!/authorization\s*:/i.test(helper))
  assert.ok(cli.includes("adminToken: env.SPONSOR_ADMIN_API_TOKEN"))
  assert.ok(cli.includes("authorization: 'Bearer ' + adminToken"))
  assert.ok(cli.includes('function safePrintableResult'))
})

test('operator UI keeps chain reconciliation distinct from fee sponsorship settlement', () => {
  assert.ok(source.includes('never marks the separate fee budget settled by itself'))
  assert.ok(source.includes('Mainnet remains disabled'))
})
