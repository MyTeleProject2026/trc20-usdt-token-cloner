import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const component = await readFile(new URL('../src/GasFreeProviderDiscovery.tsx', import.meta.url), 'utf8')
const sponsorPage = await readFile(new URL('../src/SponsorProviderPages.tsx', import.meta.url), 'utf8')
const server = await readFile(new URL('../server/index.mjs', import.meta.url), 'utf8')

test('sponsor UI requests live provider capabilities instead of showing fabricated balances', () => {
  assert.ok(component.includes('/api/gasfree/capabilities?network='))
  assert.ok(component.includes('Refresh provider inventory'))
  assert.ok(component.includes('activationFeeBaseUnits'))
  assert.ok(component.includes('transferFeeBaseUnits'))
  assert.ok(component.includes('Provider listing and API reachability do not prove funding'))
  assert.ok(component.includes('Live transfer submission: disabled'))
  assert.ok(sponsorPage.includes("import GasFreeProviderDiscovery from './GasFreeProviderDiscovery'"))
  assert.ok(sponsorPage.includes('<GasFreeProviderDiscovery />'))
})

test('GasFree API secret remains a server-only variable and is not configured in frontend source', () => {
  assert.ok(!component.includes('GASFREE_API_SECRET'))
  assert.ok(!component.includes('GASFREE_API_KEY'))
  assert.ok(server.includes("import gasFreeRoutes from './routes/gasfree.mjs'"))
  assert.ok(server.includes("app.use('/api/gasfree', gasFreeRoutes)"))
})

test('provider discovery UI never claims every exchange will credit a deposit', () => {
  assert.ok(component.includes('does not authorize or submit a transfer'))
  assert.ok(component.includes('Not a confirmed free sponsor'))
  assert.ok(component.includes('Sponsor funding verification: not established.'))
})


test('GasFree UI exposes account inspection and trace status but no transfer submission control', () => {
  assert.ok(component.includes('/api/gasfree/account?'))
  assert.ok(component.includes('Inspect provider account'))
  assert.ok(component.includes('Spendable balance not provided in the documented account response; it is unknown, not zero.'))
  assert.ok(component.includes('/api/gasfree/trace?'))
  assert.ok(component.includes('Query provider transfer status'))
  assert.ok(component.includes('Chain verification: not established by this trace lookup.'))
  assert.ok(component.includes('Live transfer submission: disabled'))
  assert.ok(!component.includes('/api/gasfree/submit'))
})


test('GasFree token list never treats a provider symbol alone as official Mainnet USDT', () => {
  assert.ok(component.includes("const OFFICIAL_MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'"))
  assert.ok(component.includes('Exact contract matches Tether-published TRON Mainnet USDT.'))
  assert.ok(component.includes('Symbol says USDT, but this is not the official Tether TRON Mainnet contract.'))
  assert.ok(component.includes('Provider symbol only: testnet assets are separate from Mainnet USDT.'))
})
