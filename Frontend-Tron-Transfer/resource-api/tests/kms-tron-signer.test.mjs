import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertKmsSignerConfiguration,
  parseKmsEcdsaDerSignature,
  recoverTronKmsSignature,
} from '../kms-tron-signer.mjs'

const OWNER = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const SPONSOR = 'TSPz5ULCfd4zbMUCfF337KWyia8F1F5kYR'

test('KMS signer stays disabled unless the explicit server-side gate is enabled', () => {
  assert.throws(
    () => assertKmsSignerConfiguration({
      role: 'owner',
      env: { TRON_OWNER_ADDRESS: OWNER, OWNER_KMS_KEY_ARN: 'arn:aws:kms:ap-southeast-1:123456789012:key/00000000-0000-0000-0000-000000000000' },
    }),
    error => error.code === 'KMS_SIGNING_DISABLED' && error.status === 423,
  )
})

test('KMS signer rejects unknown roles and missing key identity', () => {
  assert.throws(() => assertKmsSignerConfiguration({ role: 'admin', env: {}, enabled: true }), /KMS_SIGNER_ROLE_INVALID/)
  assert.throws(() => assertKmsSignerConfiguration({ role: 'owner', env: {}, enabled: true }), /KMS_SIGNING_KEY_NOT_CONFIGURED/)
})

test('KMS signer validates the Owner and Sponsor key configuration as separate identities', () => {
  const common = {
    TRON_KMS_SIGNING_ENABLED: 'true',
    TRON_OWNER_ADDRESS: OWNER,
    SPONSOR_MAINNET_ADDRESS: SPONSOR,
    OWNER_KMS_KEY_ARN: 'arn:aws:kms:ap-southeast-1:123456789012:key/00000000-0000-0000-0000-000000000001',
    SPONSOR_KMS_KEY_ARN: 'arn:aws:kms:ap-southeast-1:123456789012:key/00000000-0000-0000-0000-000000000002',
  }
  assert.equal(assertKmsSignerConfiguration({ role: 'owner', env: common }).expectedAddress, OWNER)
  assert.equal(assertKmsSignerConfiguration({ role: 'sponsor', env: common }).expectedAddress, SPONSOR)
})

test('DER ECDSA parser extracts canonical r/s scalars', () => {
  const parsed = parseKmsEcdsaDerSignature(Buffer.from('3006020101020102', 'hex'))
  assert.equal(parsed.r, '0x' + '0'.repeat(63) + '1')
  assert.equal(parsed.s, '0x' + '0'.repeat(63) + '2')
})

test('DER ECDSA parser rejects malformed and non-canonical encodings', () => {
  assert.throws(() => parseKmsEcdsaDerSignature(Buffer.from('3006020180020102', 'hex')), /KMS_SIGNATURE_DER_INTEGER_INVALID/)
  assert.throws(() => parseKmsEcdsaDerSignature(Buffer.from('3006020101020102ff', 'hex')), /KMS_SIGNATURE_DER_INVALID/)
  assert.throws(() => parseKmsEcdsaDerSignature(Buffer.from('3006020100020102', 'hex')), /KMS_SIGNATURE_SCALAR_INVALID/)
})

test('TRON signature recovery rejects a malformed transaction digest', () => {
  assert.throws(() => recoverTronKmsSignature({
    digest: 'not-a-txid', r: '0x' + '1'.padStart(64, '0'), s: '0x' + '2'.padStart(64, '0'),
    expectedAddress: OWNER, tronWeb: { address: { fromHex: value => value } },
  }), /KMS_TRANSACTION_DIGEST_INVALID/)
})

test('KMS signer refuses one KMS key shared by Owner and Sponsor', () => {
  const arn = 'arn:aws:kms:ap-southeast-1:123456789012:key/00000000-0000-0000-0000-000000000001'
  assert.throws(() => assertKmsSignerConfiguration({
    role: 'owner',
    enabled: true,
    env: {
      TRON_OWNER_ADDRESS: OWNER,
      SPONSOR_MAINNET_ADDRESS: SPONSOR,
      OWNER_KMS_KEY_ARN: arn,
      SPONSOR_KMS_KEY_ARN: arn,
    },
  }), error => error.code === 'KMS_ROLE_KEYS_MUST_BE_DISTINCT')
})
