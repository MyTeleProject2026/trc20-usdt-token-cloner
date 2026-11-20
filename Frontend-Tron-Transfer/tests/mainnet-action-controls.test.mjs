import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAINNET_ACTION_CONTROLS_KEY,
  MAINNET_ACTION_DEFAULTS,
  assertMainnetActionEnabled,
  readMainnetActionControls,
  writeMainnetActionControls,
} from '../src/mainnet-action-controls.mjs'

function memoryStorage() {
  const values = new Map()
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  }
}

test('action controls default to enabled to preserve existing workspace behavior', () => {
  assert.deepEqual(readMainnetActionControls(memoryStorage()), MAINNET_ACTION_DEFAULTS)
})

test('owner can independently disable and re-enable a local action', () => {
  const storage = memoryStorage()
  const changed = writeMainnetActionControls({ ...MAINNET_ACTION_DEFAULTS, deploymentExecution: false }, storage)
  assert.equal(changed.deploymentExecution, false)
  assert.equal(JSON.parse(storage.getItem(MAINNET_ACTION_CONTROLS_KEY)).deploymentExecution, false)
  assert.throws(() => assertMainnetActionEnabled('deploymentExecution', storage), /disabled in Owner Settings/)
  writeMainnetActionControls({ ...changed, deploymentExecution: true }, storage)
  assert.equal(assertMainnetActionEnabled('deploymentExecution', storage), true)
})

test('signing and broadcasting controls fail closed when disabled', () => {
  const storage = memoryStorage()
  writeMainnetActionControls({ ...MAINNET_ACTION_DEFAULTS, walletSigning: false, transactionBroadcast: false }, storage)
  assert.throws(() => assertMainnetActionEnabled('walletSigning', storage), /disabled in Owner Settings/)
  assert.throws(() => assertMainnetActionEnabled('transactionBroadcast', storage), /disabled in Owner Settings/)
})

test('unknown action names fail closed', () => {
  assert.throws(() => assertMainnetActionEnabled('skipSecurity', memoryStorage()), /Unknown Mainnet action control/)
})
