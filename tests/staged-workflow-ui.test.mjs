import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const entry = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8')
const app = await readFile(new URL('../src/WorkflowApp.tsx', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')

test('the live frontend entrypoint exposes only the single-owner wallet workspace', () => {
  assert.ok(entry.includes("import OwnerControlApp from './OwnerControlApp'"))
  assert.ok(entry.includes('<OwnerControlApp />'))
  assert.ok(!entry.includes("import App from './WorkflowApp.tsx'"))
  assert.ok(!entry.includes('SponsorSignerConsole'))
  assert.ok(app.includes('Network fee sponsor'))
  assert.ok(app.includes('Asset principal sponsor'))
  assert.ok(app.includes('Sender account'))
  assert.ok(app.includes('Receiver & amount'))
  assert.ok(app.includes('Review & availability'))
})

test('workspace sections are directly navigable while validation still gates continuation and review', () => {test('workspace sections are directly navigable while validation still gates continuation and review', () => {
  assert.ok(app.includes('const canEnterStep = (index: number) => index >= 0 && index < STEPS.length'))
  assert.ok(app.includes('aria-label="Workspace sections"'))
  assert.ok(app.includes('aria-label="Mobile workspace sections"'))
  assert.ok(app.includes('Open any section at any time'))
  assert.ok(app.includes('disabled={!stageCompletion[step]}'))
  assert.ok(app.includes('const sponsorStageLoaded = sponsorCheckedAt !== null && !sponsorLoading && roles?.success === true && sponsorship !== null && !sponsorError'))
  assert.ok(app.includes('const feeStageValid = feeSponsorRequired && sponsorStageLoaded'))
  assert.ok(app.includes('const senderStageValid = ADDRESS_PATTERN.test(senderAddress)'))
  assert.ok(app.includes('const receiverStageValid = ADDRESS_PATTERN.test(receiverAddress)'))
})

test('sponsor funding badges require both a successful on-chain read and verified funding', () => {
  assert.ok(app.includes('function hasVerifiedFundingSnapshot(role?: SponsorRoleSnapshot)'))
  assert.ok(app.includes('return role?.sponsorFundingVerified === true && role?.onChainBalanceRead === true'))
  assert.ok(app.includes('hasVerifiedFundingSnapshot(roles?.roles?.networkFeeSponsor)'))
  assert.ok(app.includes('hasVerifiedFundingSnapshot(roles?.roles?.assetPrincipalSponsor)'))
  assert.ok(app.includes("if (hasVerifiedFundingSnapshot(role)) return 'Funding snapshot verified'"))
  assert.ok(!app.includes("role?.sponsorFundingVerified ? 'Snapshot verified'"))
})

test('late sponsor responses cannot overwrite a newer network selection', () => {
  assert.ok(app.includes("useRef, useState } from 'react'"))
  assert.ok(app.includes('const sponsorRequestGeneration = useRef(0)'))
  assert.ok(app.includes('const requestGeneration = ++sponsorRequestGeneration.current'))
  assert.ok(app.includes('if (requestGeneration !== sponsorRequestGeneration.current) return'))
  assert.ok(app.includes('if (requestGeneration === sponsorRequestGeneration.current) setSponsorLoading(false)'))
  assert.ok(app.includes('sponsorRequestGeneration.current += 1'))
})

test('wallet inspection is testnet-only and uses real read-only balance endpoints', () => {
  assert.ok(app.includes("shasta: 'api.shasta.trongrid.io'"))
  assert.ok(app.includes("nile: 'nile.trongrid.io'"))
  assert.ok(app.includes('/api/tron/native-balance?network='))
  assert.ok(app.includes('/api/tron/token-balance?network='))
  assert.ok(app.includes('Watch-only address'))
  assert.ok(app.includes('checkedWalletNetwork(tronWeb, network)'))
  assert.ok(!app.includes('eth_sendTransaction'))
  assert.ok(app.includes('sendDirectTestnetTransfer'))
  assert.ok(app.includes('sendRawTransaction(signed)'))
  assert.ok(app.includes('/api/tron/verify-native-transfer/'))
  assert.ok(app.includes('/api/tron/verify-trc20-transfer/'))
  assert.ok(!app.includes('/api/gasfree/submit'))
  assert.ok(!app.includes('/api/tron/sponsorship/budgets/'))
})

test('sponsored submission stays blocked while direct testnet transfer remains separate', () => {
  assert.ok(app.includes('sponsored submission disabled'))
  assert.ok(app.includes('No sender-funded fallback'))
  assert.ok(app.includes('Sponsored transfer unavailable'))
  assert.ok(app.includes('disabled aria-disabled="true"'))
  assert.ok(app.includes('Copy request summary'))
  assert.ok(app.includes('This sponsor workflow remains blocked'))
  assert.ok(app.includes('This is a real on-chain testnet transaction, not a simulation.'))
  assert.ok(app.includes('Recheck sponsor readiness'))
})

test('the glass workspace includes accessible responsive desktop and mobile stage navigation', () => {
  assert.ok(app.includes('aria-label="Workspace sections"'))
  assert.ok(app.includes('aria-label="Mobile workspace sections"'))
  assert.ok(app.includes('href="#/sponsor-operator"'))
  assert.ok(app.includes('aria-current={step === index ? \'step\' : undefined}'))
  assert.ok(css.includes('.studio-sidebar'))
  assert.ok(css.includes('.studio-mobile-steps'))
  assert.ok(css.includes('@media (max-width: 880px)'))
  assert.ok(css.includes('backdrop-filter: blur'))
})
