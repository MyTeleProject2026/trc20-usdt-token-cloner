import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const authGate = await readFile(new URL('../src/AuthGate.tsx', import.meta.url), 'utf8')
const mainnetPage = await readFile(new URL('../src/MainnetExchangeDeposit.tsx', import.meta.url), 'utf8')
const workflow = await readFile(new URL('../src/WorkflowApp.tsx', import.meta.url), 'utf8')
const sponsorPilot = await readFile(new URL('../server/routes/sponsor-testnet-pilot.mjs', import.meta.url), 'utf8')
const gasFree = await readFile(new URL('../server/routes/gasfree.mjs', import.meta.url), 'utf8')

test('sign-in offers the selected testnet faucet and official TRON guide', () => {
  assert.match(authGate, /OWNER AUTHENTICATION/)
  assert.match(authGate, /Owner password/)
  assert.match(authGate, /\/api\/auth\/owner\/login/)
  assert.match(authGate, /\/api\/auth\/owner\/session/)
  assert.match(authGate, /no public backend registration/)
  assert.match(authGate, /First-time local owner wallet setup/)
  assert.match(authGate, /(?:does not|did not) create or fund USDT/)
  assert.match(authGate, /Authentication is not funding/)
})

test('testnet token flow does not misidentify user-supplied contracts as Mainnet USDT', () => {
  assert.match(workflow, /TRC-20 test token/)
  assert.match(workflow, /This is not official Mainnet USDT/)
  assert.match(workflow, /token contract address on/i)
  assert.match(workflow, /network === 'nile'/)
})

test('Mainnet exchange-deposit page clearly routes unfunded test users away from real transfers', () => {
  assert.match(mainnetPage, /No real USDT needed for testnet practice/)
  assert.match(mainnetPage, /Open testnet workspace/)
  assert.match(mainnetPage, /requires genuine USDT or TRX in the connected sender wallet/)
  assert.match(mainnetPage, /const MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'/)
  assert.match(mainnetPage, /checkMainnet\(tronWeb\)/)
  assert.match(mainnetPage, /Review and sign real Mainnet transfer/)
})

test('sponsor diagnostics remain fail-closed and cannot imply free token principal', () => {
  assert.match(sponsorPilot, /canSubmitSponsoredTransfer: false/)
  assert.match(sponsorPilot, /sponsor-ownership-and-spending-mandate-require-independent-review/)
  assert.match(gasFree, /canSubmitSponsoredTransfer: false/)
  assert.match(gasFree, /No transfer was submitted/)
})
