import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const flow = await readFile(new URL('../src/MainnetExchangeDeposit.tsx', import.meta.url), 'utf8')
const entry = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8')
const workspace = await readFile(new URL('../src/WorkflowApp.tsx', import.meta.url), 'utf8')
const verifier = await readFile(new URL('../server/routes/trc20-verification.mjs', import.meta.url), 'utf8')

test('real deposit page is separate from the existing testnet-only workspace', () => {
  assert.ok(entry.includes("import MainnetExchangeDeposit from './MainnetExchangeDeposit.tsx'"))
  assert.ok(entry.includes("route === '#/exchange-deposit'"))
  assert.ok(entry.includes('<MainnetExchangeDeposit />'))
  assert.ok(workspace.includes('href="#/exchange-deposit"'))
  assert.ok(flow.includes('TRON Mainnet'))
  assert.ok(flow.includes('Nile/Shasta assets'))
})

test('Mainnet USDT asset identity is pinned to the official Tether TRON contract', () => {
  assert.match(flow, /const MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'/)
  assert.match(flow, /const MAINNET_HOST = 'api\.trongrid\.io'/)
  assert.match(flow, /checkMainnet\(tronWeb\)/)
  assert.match(flow, /decimals !== 6/)
  assert.match(flow, /contract symbol/)
  assert.doesNotMatch(flow, /userSelectedTokenContract|customUsdtContract/i)
})

test('Mainnet transfer is locally wallet-signed, validates intent, and broadcasts only that signature', () => {
  assert.match(flow, /transactionBuilder\.sendTrx\(receiver, baseUnits, sender\)/)
  assert.match(flow, /transactionBuilder\.triggerSmartContract/)
  assert.match(flow, /transfer\(address,uint256\)/)
  assert.match(flow, /tronWeb\.trx\.sign\(unsigned\)/)
  assert.match(flow, /sendRawTransaction\(signed\)/)
  assert.match(flow, /value\.owner_address/)
  assert.match(flow, /receiverHex\.padStart\(64, '0'\)/)
  assert.match(flow, /destinationConfirmed && irreversibleConfirmed/)
  assert.match(flow, /A signature was returned/)
  assert.match(flow, /duplicate send is blocked/)
  assert.doesNotMatch(flow, /privateKey\s*[:=]/i)
  assert.doesNotMatch(flow, /mnemonic\s*[:=]/i)
})

test('deposit success requires the existing solidified TRX or TRC-20 verifier', () => {
  assert.match(flow, /\/api\/tron\/verify-native-transfer\//)
  assert.match(flow, /\/api\/tron\/verify-trc20-transfer\//)
  assert.match(flow, /solidified-transfer-verified/)
  assert.match(flow, /solidified-trc20-transfer-verified/)
  assert.match(verifier, /solidified-trc20-transfer-verified/)
  assert.match(verifier, /transferEventMatches/)
  assert.match(verifier, /executionSucceeded/)
  assert.match(flow, /awaiting-solidification/)
  assert.match(flow, /sessionStorage/)
})

test('the page never fabricates exchange account credit', () => {
  assert.match(flow, /Exchange credit: not verified/)
  assert.match(flow, /does not connect to an exchange's private deposit-status API/)
  assert.match(flow, /receiver balance is not an exchange ledger credit/)
  assert.doesNotMatch(flow, /exchange-credited|creditExchangeBalance|incrementExchangeBalance/i)
  assert.match(flow, /official deposit page/)
  assert.match(flow, /This generic page does not connect to an exchange/)
})
