import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const app = await readFile(new URL('../src/WorkflowApp.tsx', import.meta.url), 'utf8')
const roleReader = await readFile(new URL('../server/sponsor-roles.mjs', import.meta.url), 'utf8')
const sponsorConsole = await readFile(new URL('../src/SponsorSignerConsole.tsx', import.meta.url), 'utf8')

test('staged workflow loads separate fee and principal sponsor roles from the backend', () => {
  assert.ok(app.includes('/api/tron/sponsorship/roles?network='))
  assert.ok(app.includes('networkFeeSponsor'))
  assert.ok(app.includes('assetPrincipalSponsor'))
  assert.ok(app.includes('Network fee sponsor'))
  assert.ok(app.includes('Asset principal sponsor'))
  assert.ok(app.includes('Verified on-chain TRX balance'))
  assert.ok(app.includes("role?.native?.status === 'verified'"))
  assert.ok(app.includes("token.status === 'verified'"))
  assert.ok(app.includes('Available Energy'))
  assert.ok(app.includes('Provider snapshot only'))
  assert.ok(app.includes('does not prove the sponsor is funded'))
})

test('sponsor role snapshots never enable transfer submission by themselves', () => {
  assert.ok(app.includes('Sponsored transfer submission is blocked by the backend'))
  assert.ok(app.includes('Sponsored transfer unavailable'))
  assert.ok(app.includes('No sender-funded fallback'))
  assert.ok(roleReader.includes('canSubmitSponsoredTransfer: false'))
  assert.ok(roleReader.includes('resourceRead'))
  assert.ok(roleReader.includes('submissionEnabled: false'))
  assert.ok(roleReader.toLowerCase().includes('no user-funded fallback is permitted'))
})

test('fee-sponsored resource delegation is testnet-only and remains wallet-signed and verifiable', () => {
  assert.match(sponsorConsole, /type Network = 'shasta' \| 'nile'/)
  assert.ok(sponsorConsole.includes('tronWeb.transactionBuilder.delegateResource'))
  assert.ok(sponsorConsole.includes('tronWeb.trx.sign(unsigned)'))
  assert.ok(sponsorConsole.includes('tronWeb.trx.sendRawTransaction(signed)'))
  assert.ok(sponsorConsole.includes('/api/tron/sponsorship/resource-delegations/verify'))
  assert.ok(sponsorConsole.includes('maxDelegatableEnergyStakeSun'))
  assert.ok(sponsorConsole.includes('maxDelegatableBandwidthStakeSun'))
  assert.ok(sponsorConsole.includes("contracts[0]?.type !== 'DelegateResourceContract'"))
  assert.ok(sponsorConsole.includes('No signature was requested.'))
  assert.ok(sponsorConsole.includes('Do not resubmit or create a replacement delegation'))
  assert.doesNotMatch(sponsorConsole, /privateKey\s*[:=]/i)
  assert.ok(roleReader.includes('canSubmitSponsoredTransfer: false'))
})
