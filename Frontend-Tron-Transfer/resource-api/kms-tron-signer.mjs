import { createPublicKey } from 'node:crypto'
import { computeAddress, getBytes, hexlify, recoverAddress, Signature } from 'ethers'

const ROLE_CONFIG = Object.freeze({
  owner: Object.freeze({ keyEnv: 'OWNER_KMS_KEY_ARN', addressEnv: 'TRON_OWNER_ADDRESS' }),
  sponsor: Object.freeze({ keyEnv: 'SPONSOR_KMS_KEY_ARN', addressEnv: 'SPONSOR_MAINNET_ADDRESS' }),
})
const TXID = /^[0-9a-f]{64}$/i
const DER_PREFIX = 0x30
const SECP256K1_ORDER = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')
const HALF_ORDER = SECP256K1_ORDER >> 1n

function fail(code, status = 503) {
  throw Object.assign(new Error(code), { code, status })
}

function readDerLength(bytes, offset) {
  const first = bytes[offset]
  if (first === undefined) fail('KMS_SIGNATURE_DER_INVALID', 502)
  if (first < 0x80) return { length: first, next: offset + 1 }
  const count = first & 0x7f
  if (count < 1 || count > 2 || offset + count >= bytes.length) fail('KMS_SIGNATURE_DER_INVALID', 502)
  let length = 0
  for (let i = 0; i < count; i++) length = (length << 8) | bytes[offset + 1 + i]
  if (length < 0x80) fail('KMS_SIGNATURE_DER_NON_CANONICAL', 502)
  return { length, next: offset + 1 + count }
}

function readDerInteger(bytes, offset) {
  if (bytes[offset] !== 0x02) fail('KMS_SIGNATURE_DER_INVALID', 502)
  const field = readDerLength(bytes, offset + 1)
  const start = field.next
  const end = start + field.length
  if (!field.length || end > bytes.length) fail('KMS_SIGNATURE_DER_INVALID', 502)
  const value = bytes.subarray(start, end)
  if ((value[0] & 0x80) !== 0 || (value.length > 1 && value[0] === 0 && (value[1] & 0x80) === 0)) {
    fail('KMS_SIGNATURE_DER_INTEGER_INVALID', 502)
  }
  const normalized = value[0] === 0 ? value.subarray(1) : value
  if (!normalized.length || normalized.length > 32) fail('KMS_SIGNATURE_DER_INTEGER_RANGE', 502)
  return { value: BigInt('0x' + normalized.toString('hex')), next: end }
}

export function parseKmsEcdsaDerSignature(der) {
  const bytes = Buffer.from(der || [])
  if (bytes.length < 8 || bytes[0] !== DER_PREFIX) fail('KMS_SIGNATURE_DER_INVALID', 502)
  const sequence = readDerLength(bytes, 1)
  if (sequence.next + sequence.length !== bytes.length) fail('KMS_SIGNATURE_DER_INVALID', 502)
  const r = readDerInteger(bytes, sequence.next)
  const s = readDerInteger(bytes, r.next)
  if (s.next !== bytes.length || r.value <= 0n || r.value >= SECP256K1_ORDER || s.value <= 0n || s.value >= SECP256K1_ORDER) {
    fail('KMS_SIGNATURE_SCALAR_INVALID', 502)
  }
  const lowS = s.value > HALF_ORDER ? SECP256K1_ORDER - s.value : s.value
  return Object.freeze({
    r: '0x' + r.value.toString(16).padStart(64, '0'),
    s: '0x' + lowS.toString(16).padStart(64, '0'),
  })
}

function publicKeyTronAddress(publicKeyDer, tronWeb) {
  let jwk
  try { jwk = createPublicKey({ key: Buffer.from(publicKeyDer), format: 'der', type: 'spki' }).export({ format: 'jwk' }) }
  catch { fail('KMS_PUBLIC_KEY_INVALID', 503) }
  if (!jwk?.x || !jwk?.y) fail('KMS_PUBLIC_KEY_NOT_SECP256K1', 503)
  const uncompressed = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ])
  if (uncompressed.length !== 65) fail('KMS_PUBLIC_KEY_INVALID', 503)
  const evmAddress = computeAddress(hexlify(uncompressed))
  return tronWeb.address.fromHex('41' + evmAddress.slice(2))
}

export function recoverTronKmsSignature({ digest, r, s, expectedAddress, tronWeb }) {
  if (!TXID.test(String(digest || ''))) fail('KMS_TRANSACTION_DIGEST_INVALID', 400)
  const normalizedDigest = '0x' + digest.toLowerCase()
  for (let recovery = 0; recovery <= 3; recovery++) {
    try {
      const signature = Signature.from({ r, s, v: 27 + recovery })
      const evmAddress = recoverAddress(normalizedDigest, signature)
      const tronAddress = tronWeb.address.fromHex('41' + evmAddress.slice(2))
      if (tronAddress === expectedAddress) {
        return (r.slice(2) + s.slice(2) + recovery.toString(16).padStart(2, '0')).toLowerCase()
      }
    } catch { /* try the remaining recovery IDs */ }
  }
  fail('KMS_SIGNATURE_RECOVERED_ADDRESS_MISMATCH', 502)
}

export function assertKmsSignerConfiguration({ role, env = process.env, enabled = env.TRON_KMS_SIGNING_ENABLED === 'true' } = {}) {
  const config = ROLE_CONFIG[role]
  if (!config) fail('KMS_SIGNER_ROLE_INVALID', 400)
  if (!enabled) fail('KMS_SIGNING_DISABLED', 423)
  const keyArn = String(env[config.keyEnv] || '').trim()
  const expectedAddress = String(env[config.addressEnv] || '').trim()
  if (!keyArn || !/^arn:aws:kms:[a-z0-9-]+:\d{12}:key\/[0-9a-f-]{36}$/i.test(keyArn)) fail('KMS_SIGNING_KEY_NOT_CONFIGURED', 503)
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(expectedAddress)) fail('KMS_SIGNING_WALLET_IDENTITY_NOT_CONFIGURED', 503)
  if (role === 'sponsor' && expectedAddress === String(env.TRON_OWNER_ADDRESS || env.TRON_OWNER_WALLET_ADDRESS || '')) {
    fail('KMS_OWNER_SPONSOR_IDENTITIES_NOT_DISTINCT', 503)
  }
  return Object.freeze({ role, keyArn, expectedAddress })
}

export async function createKmsTronSigner({
  env = process.env,
  tronWeb,
  kmsClient = null,
  kmsClientFactory = null,
} = {}) {
  if (!tronWeb?.address?.fromHex) throw new TypeError('A Mainnet TronWeb address adapter is required')
  let client = kmsClient
  async function getClient() {
    if (client) return client
    if (typeof kmsClientFactory === 'function') client = await kmsClientFactory()
    else {
      const sdk = await import('@aws-sdk/client-kms')
      client = new sdk.KMSClient({ region: env.AWS_REGION || env.AWS_DEFAULT_REGION })
    }
    return client
  }
  async function send(commandName, input) {
    const sdk = await import('@aws-sdk/client-kms')
    const command = commandName === 'GetPublicKey' ? new sdk.GetPublicKeyCommand(input) : new sdk.SignCommand(input)
    return (await getClient()).send(command)
  }
  const publicKeys = new Map()
  async function verifyKey(role, config) {
    if (publicKeys.has(config.keyArn)) {
      const cachedAddress = publicKeys.get(config.keyArn)
      if (cachedAddress !== config.expectedAddress) fail('KMS_KEY_REUSED_ACROSS_WALLET_ROLES', 503)
      return cachedAddress
    }
    const result = await send('GetPublicKey', { KeyId: config.keyArn })
    if (result.KeySpec !== 'ECC_SECG_P256K1' || result.KeyUsage !== 'SIGN_VERIFY'
      || !Array.isArray(result.SigningAlgorithms) || !result.SigningAlgorithms.includes('ECDSA_SHA_256')) {
      fail('KMS_KEY_SPEC_OR_USAGE_INVALID', 503)
    }
    const address = publicKeyTronAddress(result.PublicKey, tronWeb)
    if (address !== config.expectedAddress) fail('KMS_PUBLIC_KEY_ADDRESS_MISMATCH', 503)
    publicKeys.set(config.keyArn, address)
    return address
  }
  async function signPreparedTransaction({ role, transaction }) {
    const config = assertKmsSignerConfiguration({ role, env })
    if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)
      || !TXID.test(String(transaction.txID || ''))
      || !/^(?:[0-9a-f]{2})+$/i.test(String(transaction.raw_data_hex || ''))
      || transaction.signature?.length) fail('KMS_UNSIGNED_TRANSACTION_INVALID', 409)
    const computedTxId = (await import('node:crypto')).createHash('sha256')
      .update(Buffer.from(transaction.raw_data_hex, 'hex')).digest('hex')
    if (computedTxId !== String(transaction.txID).toLowerCase()) fail('KMS_UNSIGNED_TRANSACTION_ID_MISMATCH', 409)
    await verifyKey(role, config)
    const result = await send('Sign', {
      KeyId: config.keyArn,
      Message: getBytes('0x' + computedTxId),
      MessageType: 'DIGEST',
      SigningAlgorithm: 'ECDSA_SHA_256',
    })
    if (result.KeyId && result.KeyId !== config.keyArn) fail('KMS_SIGNING_KEY_ID_MISMATCH', 502)
    if (!result.Signature) fail('KMS_SIGNATURE_MISSING', 502)
    const { r, s } = parseKmsEcdsaDerSignature(result.Signature)
    const signature = recoverTronKmsSignature({ digest: computedTxId, r, s, expectedAddress: config.expectedAddress, tronWeb })
    const signed = { ...structuredClone(transaction), signature: [signature] }
    if (signed.txID !== transaction.txID || signed.raw_data_hex !== transaction.raw_data_hex) fail('KMS_SIGNED_TRANSACTION_MUTATED', 502)
    return Object.freeze({ signedTransaction: signed, signerAddress: config.expectedAddress, keyArn: config.keyArn, digest: computedTxId })
  }
  return Object.freeze({ signPreparedTransaction, verifyKey })
}
