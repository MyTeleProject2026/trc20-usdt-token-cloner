import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import {
  decryptWalletPrivateKey,
  encryptWalletPrivateKey,
  isEncryptedWalletRecord,
  WALLET_KDF_ITERATIONS,
} from '../src/wallet-vault-crypto.mjs'

const address = 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL'
const privateKey = '0000000000000000000000000000000000000000000000000000000000000001'
const password = 'a-strong-local-wallet-password'

test('wallet keystore encrypts key material with PBKDF2 and AES-GCM without storing a raw private key', async () => {
  const record = await encryptWalletPrivateKey(privateKey, address, password, webcrypto)
  assert.equal(isEncryptedWalletRecord(record), true)
  assert.equal(record.kdf.iterations, WALLET_KDF_ITERATIONS)
  assert.equal(record.cipher.name, 'AES-GCM')
  assert.equal(JSON.stringify(record).includes(privateKey), false)
  assert.equal(await decryptWalletPrivateKey(record, password, webcrypto), privateKey)
})

test('wallet keystore uses a fresh salt and IV each time and rejects password or record tampering', async () => {
  const first = await encryptWalletPrivateKey(privateKey, address, password, webcrypto)
  const second = await encryptWalletPrivateKey(privateKey, address, password, webcrypto)
  assert.notEqual(first.kdf.salt, second.kdf.salt)
  assert.notEqual(first.cipher.iv, second.cipher.iv)
  await assert.rejects(decryptWalletPrivateKey(first, 'wrong-password', webcrypto), /could not be unlocked/)
  const tampered = { ...first, ciphertext: (first.ciphertext[0] === 'A' ? 'B' : 'A') + first.ciphertext.slice(1) }
  await assert.rejects(decryptWalletPrivateKey(tampered, password, webcrypto), /could not be unlocked/)
})

test('wallet keystore rejects weak passwords and malformed private keys', async () => {
  await assert.rejects(encryptWalletPrivateKey(privateKey, address, 'short', webcrypto), /between 12 and 128 characters/)
  await assert.rejects(encryptWalletPrivateKey('not-a-private-key', address, password, webcrypto), /32 bytes/)
  assert.equal(isEncryptedWalletRecord({ version: 1, address }), false)
})
