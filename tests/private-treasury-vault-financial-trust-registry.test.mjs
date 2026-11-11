import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, createHash } from 'node:crypto'
import { getPrivateTreasuryVaultFinancialTrustRegistry } from '../server/private-treasury-vault-financial-trust-registry.mjs'

function fixture() {
  const { publicKey } = generateKeyPairSync('ed25519')
  const keys = { 'financial-key-01': {
    status: 'active', issuer: 'vault.example', audiences: ['tron-transfer-private-treasury'],
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    notBeforeMs: 1_700_000_000_000, notAfterMs: 1_900_000_000_000,
  } }
  const normalized = Object.entries(keys).map(([keyId, item]) => ({ keyId, ...item }))
  const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const revoked = []
  return {
    PRIVATE_TREASURY_VAULT_TRUST_VERSION: 'test-v1',
    PRIVATE_TREASURY_VAULT_TRUSTED_KEYS_JSON: JSON.stringify(keys),
    PRIVATE_TREASURY_VAULT_TRUST_SHA256: digest(normalized),
    PRIVATE_TREASURY_VAULT_REVOKED_KEY_IDS_JSON: JSON.stringify(revoked),
    PRIVATE_TREASURY_VAULT_REVOCATIONS_SHA256: digest(revoked),
  }
}

test('loads a separately pinned Ed25519 financial-vault registry', () => {
  const registry = getPrivateTreasuryVaultFinancialTrustRegistry(fixture(), 1_800_000_000_000)
  assert.equal(registry.configured, true)
  assert.equal(registry.trustedKeys.get('financial-key-01').issuer, 'vault.example')
  assert.deepEqual(registry.trustedKeys.get('financial-key-01').audiences, ['tron-transfer-private-treasury'])
})
test('fails closed when either trust or revocation digest differs', () => {
  const env = fixture()
  env.PRIVATE_TREASURY_VAULT_TRUST_SHA256 = '0'.repeat(64)
  assert.equal(getPrivateTreasuryVaultFinancialTrustRegistry(env, 1_800_000_000_000).reason, 'financial-vault-trust-digest-mismatch')
  const revoked = fixture()
  revoked.PRIVATE_TREASURY_VAULT_REVOCATIONS_SHA256 = 'f'.repeat(64)
  assert.equal(getPrivateTreasuryVaultFinancialTrustRegistry(revoked, 1_800_000_000_000).reason, 'financial-vault-revocations-digest-mismatch')
})
test('rejects malformed, expired, non-Ed25519 and unpinned registry entries', () => {
  const env = fixture()
  env.PRIVATE_TREASURY_VAULT_TRUSTED_KEYS_JSON = '{"bad":{"active":true}}'
  assert.equal(getPrivateTreasuryVaultFinancialTrustRegistry(env, 1_800_000_000_000).configured, false)
  assert.equal(getPrivateTreasuryVaultFinancialTrustRegistry({}, 1_800_000_000_000).configured, false)
})

test('financial trust snapshots deeply protect key records, audiences, revocations and Map mutation', () => {
  const registry = getPrivateTreasuryVaultFinancialTrustRegistry(fixture(), 1_800_000_000_000)
  assert.equal(registry.configured, true)
  assert.ok(registry.trustedKeys instanceof Map)
  assert.throws(() => registry.trustedKeys.set('attacker-key', {}), /read-only/)
  assert.throws(() => registry.trustedKeys.delete('financial-key-01'), /read-only/)
  assert.throws(() => registry.trustedKeys.clear(), /read-only/)
  const key = registry.trustedKeys.get('financial-key-01')
  assert.ok(Object.isFrozen(key))
  assert.ok(Object.isFrozen(key.audiences))
  assert.throws(() => key.audiences.push('attacker-audience'), TypeError)
  assert.throws(() => { key.audiences[0] = 'attacker-audience' }, TypeError)
  assert.ok(Object.isFrozen(registry.revokedKeyIds))
  assert.throws(() => registry.revokedKeyIds.push('financial-key-01'), TypeError)
  registry.trustedKeys.forEach((_value, _key, map) => {
    assert.equal(map, registry.trustedKeys)
    assert.throws(() => map.set('attacker-key', {}), /read-only/)
  })
})

test('unavailable trust snapshots also expose a non-mutable empty key map', () => {
  const registry = getPrivateTreasuryVaultFinancialTrustRegistry({}, 1_800_000_000_000)
  assert.equal(registry.configured, false)
  assert.throws(() => registry.trustedKeys.set('attacker-key', {}), /read-only/)
})
