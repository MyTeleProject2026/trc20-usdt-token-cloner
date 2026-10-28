import assert from 'node:assert/strict'
import test from 'node:test'
import { createOwnerPasswordHash } from '../scripts/generate-owner-password-hash.mjs'

test('owner password generator emits the exact scrypt format consumed by the backend', async () => {
  const password = 'test-only-owner-password-1234'
  const salt = Buffer.alloc(16, 0x5a)
  const encoded = await createOwnerPasswordHash(password, salt)
  const parts = encoded.split('$')
  assert.equal(parts.length, 3)
  assert.equal(parts[0], 'scrypt')
  assert.deepEqual(Buffer.from(parts[1], 'base64url'), salt)
  assert.equal(Buffer.from(parts[2], 'base64url').length, 64)
  assert.equal(encoded.includes(password), false)
})

test('owner password generator refuses short passwords and invalid salts', async () => {
  await assert.rejects(() => createOwnerPasswordHash('too-short', Buffer.alloc(16, 0x5a)), /16 and 1024/)
  await assert.rejects(() => createOwnerPasswordHash('a-strong-enough-password', Buffer.alloc(8)), /salt/)
})

test('owner password hashes use a fresh salt when omitted', async () => {
  const password = 'test-only-owner-password-1234'
  const first = await createOwnerPasswordHash(password)
  const second = await createOwnerPasswordHash(password)
  assert.notEqual(first, second)
  assert.equal(first.split('$')[0], 'scrypt')
  assert.equal(second.split('$')[0], 'scrypt')
})
