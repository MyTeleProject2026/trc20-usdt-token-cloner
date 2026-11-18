import test from 'node:test'
import assert from 'node:assert/strict'
import { getFincraWebhookTransition } from '../server/fincra-payout-state.mjs'

test('Fincra success advances only a submitted/reconciliation request to chain verification', () => {
  for (const requestStatus of ['submission-unknown', 'provider-processing', 'awaiting-chain-verification']) {
    assert.deepEqual(getFincraWebhookTransition({
      requestStatus,
      previousProviderStatus: 'processing',
      providerStatus: 'successful',
    }), { allowed: true, nextStatus: 'awaiting-chain-verification', reason: null })
  }
})

test('Fincra failure advances only an eligible request to provider-failed', () => {
  assert.deepEqual(getFincraWebhookTransition({
    requestStatus: 'provider-processing',
    previousProviderStatus: 'processing',
    providerStatus: 'failed',
  }), { allowed: true, nextStatus: 'provider-failed', reason: null })
})

test('new request intake cannot be advanced by a signed provider event', () => {
  for (const requestStatus of ['awaiting-provider-authorization', 'pending', 'provider-failed', 'settled']) {
    const result = getFincraWebhookTransition({
      requestStatus,
      previousProviderStatus: null,
      providerStatus: 'successful',
    })
    assert.equal(result.allowed, false)
    assert.equal(result.nextStatus, null)
    assert.equal(result.reason, 'payout-not-in-submitted-or-reconciliation-state')
  }
})

test('terminal provider outcomes cannot be reversed by a later contradictory event', () => {
  assert.equal(getFincraWebhookTransition({
    requestStatus: 'awaiting-chain-verification',
    previousProviderStatus: 'successful',
    providerStatus: 'failed',
  }).reason, 'terminal-provider-status-conflict')
  assert.equal(getFincraWebhookTransition({
    requestStatus: 'provider-processing',
    previousProviderStatus: 'failed',
    providerStatus: 'successful',
  }).reason, 'terminal-provider-status-conflict')
})

test('non-final provider statuses cannot advance local payout state', () => {
  for (const providerStatus of ['pending', 'processing', 'unknown', '']) {
    assert.equal(getFincraWebhookTransition({
      requestStatus: 'provider-processing',
      previousProviderStatus: 'processing',
      providerStatus,
    }).reason, 'provider-status-not-final')
  }
})

test('successful provider status never maps to chain settlement', () => {
  const result = getFincraWebhookTransition({
    requestStatus: 'submission-unknown',
    previousProviderStatus: null,
    providerStatus: 'successful',
  })
  assert.equal(result.nextStatus, 'awaiting-chain-verification')
  assert.notEqual(result.nextStatus, 'settled')
})
