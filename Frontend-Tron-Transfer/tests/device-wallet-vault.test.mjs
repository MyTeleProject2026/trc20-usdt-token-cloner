import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { unlockDeviceWallet, saveDeviceWallet, hasDeviceWallet } from '../src/lib/device-wallet-vault.mjs'
const source = await readFile(new URL('../src/lib/device-wallet-vault.mjs', import.meta.url), 'utf8')
test('device wallet keys are role-scoped, non-exportable AES-GCM keys stored in IndexedDB', () => {
  assert.match(source, /indexedDB\.open\(DB_NAME,DB_VERSION\)/)
  assert.match(source, /generateKey\(\{name:'AES-GCM',length:256\},false/)
  assert.match(source, /key\.extractable!==false/)
  assert.match(source, /tron-transfer:device-wallet:v1:/)
  assert.match(source, /role!=='owner'&&role!=='sponsor'/)
  assert.match(source, /additionalData:aad\(role,address\)/)
  assert.doesNotMatch(source, /localStorage|sessionStorage|password/i)
})
test('device wallet vault fails closed when secure IndexedDB is unavailable', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
  try {
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined })
    await assert.rejects(unlockDeviceWallet('owner'), /secure browser with IndexedDB/)
    await assert.rejects(saveDeviceWallet('sponsor', { address: 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL', privateKey: '1'.repeat(64) }), /secure browser with IndexedDB/)
    assert.equal(await hasDeviceWallet('owner'), false)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'indexedDB', previous)
    else delete globalThis.indexedDB
  }
})
