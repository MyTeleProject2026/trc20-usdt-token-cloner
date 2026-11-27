import test from 'node:test'
import { webcrypto } from 'node:crypto'
import assert from 'node:assert/strict'
import { TronWeb } from 'tronweb'
import { assertMainnetWallet, deployContractWithOwnerSigner } from '../src/trax-mainnet.mjs'
import {
  createOwnerTronWeb, deriveOwnerAccount, getSavedOwnerWalletAddress,
  saveOwnerWalletVault, unlockOwnerWalletVault, removeSavedOwnerWallet, migrateOwnerWalletVault,
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
  const spaced = await deriveOwnerAccount({ mode: 'mnemonic', value: '  ' + MNEMONIC.replaceAll(' ', '   ') + '  ' })
  assert.equal(spaced.address, account.address)
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
    await saveOwnerWalletVault(account, 'Abc123!@')
    const eightCharacterVault = await unlockOwnerWalletVault('Abc123!@')
    assert.equal(eightCharacterVault.address, account.address)
    assert.equal(eightCharacterVault.privateKey, PRIVATE_KEY)
    removeSavedOwnerWallet()
    assert.equal(getSavedOwnerWalletAddress(), '')
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previousStorage
  }
})

test('refuses weak vault passwords and mismatched imported addresses', async () => {
  const account = await deriveOwnerAccount({ mode: 'private-key', value: PRIVATE_KEY })
  await assert.rejects(saveOwnerWalletVault(account, 'short'), /at least 8 characters/)
  await assert.rejects(saveOwnerWalletVault({ ...account, address: 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp' }, 'owner-vault-password-strong'), /does not match/)
})

test('local Owner Wallet signer passes the shared Mainnet wallet gate without an injected provider', async () => {
  const account = await deriveOwnerAccount({ mode: 'private-key', value: PRIVATE_KEY })
  const tronWeb = createOwnerTronWeb(account.privateKey)
  const wallet = { address: account.address, tronWeb, provider: null, signerType: 'encrypted-local-owner-vault' }
  assert.equal(assertMainnetWallet(wallet), tronWeb)
  assert.equal(typeof tronWeb.trx.sign, 'function')
  assert.equal(typeof tronWeb.trx.sendRawTransaction, 'function')
  assert.equal(typeof deployContractWithOwnerSigner, 'function')
})

test('local Owner signer signs a locally built transaction offline without broadcasting it', async () => {
  const account = await deriveOwnerAccount({ mode: 'private-key', value: PRIVATE_KEY })
  const tronWeb = createOwnerTronWeb(account.privateKey)
  let broadcastCalls = 0
  tronWeb.trx.sendRawTransaction = async () => { broadcastCalls += 1; throw new Error('Broadcast must not run in this test.') }
  const now = Date.now()
  const unsigned = await tronWeb.transactionBuilder.sendTrx('TJRabPrwbZy45sbavfcjinPJC18kjpRTv8', 1, account.address, {
    blockHeader: {
      ref_block_bytes: '0001',
      ref_block_hash: '0000000000000000',
      expiration: now + 60_000,
      timestamp: now,
    },
  })
  assert.equal(unsigned.raw_data.contract[0].type, 'TransferContract')
  const signed = await tronWeb.trx.sign(unsigned, account.privateKey)
  assert.equal(signed.txID, unsigned.txID)
  assert.equal(Array.isArray(signed.signature), true)
  assert.equal(signed.signature.length, 1)
  assert.match(signed.signature[0], /^[0-9a-f]{130}$/i)
  assert.equal(broadcastCalls, 0)
})


test('Owner vault migration verifies the new credential, rejects a wrong legacy password, and recovers an interrupted local write', async () => {
  const priorStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const priorCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  const values = new Map()
  let interruptNextWrite = false
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: key => values.has(key) ? values.get(key) : null,
      setItem: (key, value) => {
        values.set(key, String(value))
        if (interruptNextWrite) {
          interruptNextWrite = false
          throw new Error('simulated-owner-vault-write-interruption')
        }
      },
      removeItem: key => values.delete(key),
    },
  })
  try {
    const account = await deriveOwnerAccount({ mode: 'private-key', value: PRIVATE_KEY })
    const oldPassword = 'old-owner-vault-password'
    const newPassword = 'Abc123!@'
    await saveOwnerWalletVault(account, oldPassword)
    const original = values.get('tron-transfer.owner-wallet.v1')

    await assert.rejects(migrateOwnerWalletVault('wrong-old-password', newPassword), /Unable to unlock the Owner Wallet/)
    assert.equal(values.get('tron-transfer.owner-wallet.v1'), original)
    assert.equal((await unlockOwnerWalletVault(oldPassword)).address, account.address)

    interruptNextWrite = true
    await assert.rejects(migrateOwnerWalletVault(oldPassword, newPassword), /simulated-owner-vault-write-interruption/)
    assert.equal(values.get('tron-transfer.owner-wallet.v1'), original)
    const restored = await unlockOwnerWalletVault(oldPassword)
    assert.equal(restored.address, account.address)
    assert.equal(restored.privateKey, PRIVATE_KEY)

    const migrated = await migrateOwnerWalletVault(oldPassword, newPassword)
    assert.equal(migrated.address, account.address)
    assert.equal(migrated.privateKey, PRIVATE_KEY)
    await assert.rejects(unlockOwnerWalletVault(oldPassword), /Unable to unlock the Owner Wallet/)
    assert.equal((await unlockOwnerWalletVault(newPassword)).address, account.address)
  } finally {
    if (priorStorage) Object.defineProperty(globalThis, 'localStorage', priorStorage)
    else delete globalThis.localStorage
    if (priorCrypto) Object.defineProperty(globalThis, 'crypto', priorCrypto)
    else delete globalThis.crypto
  }
})
