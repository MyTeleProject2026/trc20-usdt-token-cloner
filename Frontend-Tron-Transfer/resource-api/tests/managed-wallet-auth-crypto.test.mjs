import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createWalletSessionSecrets,
  hashWalletPassword,
  hashWalletSessionToken,
  validateWalletPassword,
  verifyWalletPassword,
} from '../managed-wallet-auth-crypto.mjs'

test('wallet password policy rejects weak, oversized, and control-character passwords', () => {
  assert.equal(validateWalletPassword('1234567'), false)
  assert.equal(validateWalletPassword('12345678'), true)
  assert.equal(validateWalletPassword('long-enough-password-123'), true)
  assert.equal(validateWalletPassword('valid-password\n-invalid'), false)
  assert.equal(validateWalletPassword('x'.repeat(1025)), false)
  assert.equal(validateWalletPassword(null), false)
})

test('scrypt password verifier uses unique salts and verifies only the matching password', async () => {
  const first = await hashWalletPassword('correct horse battery staple 42')
  const second = await hashWalletPassword('correct horse battery staple 42')
  assert.equal(first.passwordAlgorithm, 'scrypt')
  assert.equal(first.passwordHash.length, 128)
  assert.equal(first.passwordSalt.length, 32)
  assert.notEqual(first.passwordSalt, second.passwordSalt)
  assert.equal(await verifyWalletPassword('correct horse battery staple 42', first), true)
  assert.equal(await verifyWalletPassword('incorrect password 123', first), false)
  assert.equal(await verifyWalletPassword('correct horse battery staple 42', { ...first, passwordParams: { N: 16, r: 8, p: 1 } }), false)
  assert.equal(await verifyWalletPassword('correct horse battery staple 42', { ...first, passwordAlgorithm: 'plain' }), false)
})

test('session tokens are high entropy and only their SHA-256 digests are suitable for persistence', () => {
  const first = createWalletSessionSecrets()
  const second = createWalletSessionSecrets()
  assert.equal(first.sessionToken.length >= 40, true)
  assert.equal(first.csrfToken.length >= 40, true)
  assert.equal(first.tokenHash.length, 64)
  assert.equal(first.csrfHash.length, 64)
  assert.notEqual(first.sessionToken, second.sessionToken)
  assert.equal(hashWalletSessionToken(first.sessionToken), first.tokenHash)
  assert.equal(hashWalletSessionToken('not-a-session-token'), null)
})
