import test from 'node:test'
import assert from 'node:assert/strict'
import { TronWeb } from 'tronweb'
import {
  createOwnerTronWeb, deriveOwnerAccount, getSavedOwnerWalletAddress,
  saveOwnerWalletVault, unlockOwnerWalletVault, removeSavedOwnerWallet,
} from '../src/owner-wallet-vault.mjs'

const PRIVATE_KEY = '0000000000000000000000000000000000000000000000000000000000000001'
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

test('derives a valid TRON Mainnet owner from an existing private key', async () => {
  const account = await deriveOwnerAccount({ mode: 'private-key', value: PRIVATE_KEY })
  assert.equal(account.network, 'mainnet')
  assert.equal(TronWeb.isAddress(account.address), true)
  const signer = createOwnerTronWeb(account.privateKey)
  assert.equal(signer.defaultAddress.base58, account.address)
  assert.equal(typeof signer.trx.sign, 'function')
  assert.equal(typeof signer.trx.sendRawTransaction, 'function')
})

test('derives an existing owner account from a TRON mnemonic', async () => {
  const account = await deriveOwnerAccount({ mode: 'mnemonic', value: MNEMONIC })
  assert.equal(account.network, 'mainnet')
  assert.equal(TronWeb.isAddress(account.address), true)
  assert.equal(account.privateKey.length, 64)
})

test('encrypts Owner Wallet locally, preserves address integrity and rejects wrong password', async () => {
  const values = new Map()
  const previousStorage = globalThis.localStorage
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  }
  try {
    const account = await deriveOwnerAccount({ mode: 'private-key', value: PRIVATE_KEY })
    await saveOwnerWalletVault(account, 'owner-vault-password-strong')
    const raw = values.get('tron-transfer.owner-wallet.v1')
    assert.ok(raw)
    assert.equal(raw.includes(PRIVATE_KEY), false)
    assert.equal(getSavedOwnerWalletAddress(), account.address)
    const restored = await unlockOwnerWalletVault('owner-vault-password-strong')
    assert.equal(restored.address, account.address)
    assert.equal(restored.privateKey, PRIVATE_KEY)
    await assert.rejects(unlockOwnerWalletVault('incorrect-password'), /Unable to unlock the Owner Wallet/)
    removeSavedOwnerWallet()
    assert.equal(getSavedOwnerWalletAddress(), '')
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previousStorage
  }
})

test('refuses weak vault passwords and mismatched imported addresses', async () => {
  const account = await deriveOwnerAccount({ mode: 'private-key', value: PRIVATE_KEY })
  await assert.rejects(saveOwnerWalletVault(account, 'short'), /at least 12 characters/)
  await assert.rejects(saveOwnerWalletVault({ ...account, address: 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp' }, 'owner-vault-password-strong'), /does not match/)
})
