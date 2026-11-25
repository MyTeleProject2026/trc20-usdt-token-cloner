import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const manager = await readFile(new URL('../src/SponsorWalletManager.jsx', import.meta.url), 'utf8')
const api = await readFile(new URL('../resource-api/sponsor-api.mjs', import.meta.url), 'utf8')
const server = await readFile(new URL('../resource-api/server.js', import.meta.url), 'utf8')

test('Sponsor workspace derives Owner recipient from public Mainnet status without Owner login', () => {
  assert.match(manager, /sponsorApiRequest\('\/api\/sponsor\/status'\)/)
  assert.match(manager, /typeof status\?\.ownerAddress === 'string'/)
  assert.match(manager, /setOwnerAddress\(configuredOwnerAddress\)/)
  assert.match(manager, /void ownerAuth\.session\(\)/)
  assert.match(manager, /explicitly guarded, one-time Sponsor ledger bootstrap/)
  assert.doesNotMatch(manager, /Authenticate the configured Owner account first/)
  assert.doesNotMatch(manager, /const OWNER_ADDRESS\s*=/)
  assert.doesNotMatch(manager, /TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp/)
})

test('Sponsor API requires explicit Owner Mainnet address configuration with no static fallback', () => {
  assert.match(api, /allowedAddress = env\.TRON_OWNER_ADDRESS \|\| env\.TRON_OWNER_WALLET_ADDRESS \|\| ''/)
  assert.match(server, /allowedAddress = env\.TRON_OWNER_ADDRESS \|\| env\.TRON_OWNER_WALLET_ADDRESS \|\| ''/)
  assert.doesNotMatch(api + server, /TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp/)
})

test('Sponsor workspace has no third-party resource acquisition action', () => {
  assert.doesNotMatch(manager, /Acquire Energy \/ Bandwidth|Provider unavailable/)
})
