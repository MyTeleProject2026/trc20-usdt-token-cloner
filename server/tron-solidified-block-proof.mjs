import { createHash } from 'node:crypto'
import { recoverAddress } from 'ethers'

const HEX_BYTES = /^(?:[0-9a-f]{2})+$/i
const HASH_HEX = /^[0-9a-f]{64}$/i
const MAX_UINT64 = (1n << 64n) - 1n

class ProofError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest()
}

function toBigInt(value, label, { allowZero = true } = {}) {
  let parsed
  if (typeof value === 'bigint') parsed = value
  else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value)
  else if (typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value)) parsed = BigInt(value)
  else throw new ProofError('invalid-' + label)
  if (parsed < 0n || parsed > MAX_UINT64 || (!allowZero && parsed === 0n)) {
    throw new ProofError('invalid-' + label)
  }
  return parsed
}

function encodeVarint(value) {
  let remaining = BigInt.asUintN(64, BigInt(value))
  const bytes = []
  while (remaining > 0x7fn) {
    bytes.push(Number((remaining & 0x7fn) | 0x80n))
    remaining >>= 7n
  }
  bytes.push(Number(remaining))
  return Buffer.from(bytes)
}

function encodeVarintField(fieldNumber, value) {
  const parsed = toBigInt(value, 'protobuf-integer')
  if (parsed === 0n) return Buffer.alloc(0)
  return Buffer.concat([
    encodeVarint(BigInt(fieldNumber * 8)),
    encodeVarint(parsed),
  ])
}

function bytesFromHex(value, label, { required = true, exactBytes = null } = {}) {
  if (typeof value !== 'string' || !HEX_BYTES.test(value)) {
    if (!required && (value === undefined || value === null || value === '')) return Buffer.alloc(0)
    throw new ProofError('invalid-' + label)
  }
  const result = Buffer.from(value, 'hex')
  if (exactBytes !== null && result.length !== exactBytes) throw new ProofError('invalid-' + label)
  return result
}

function encodeBytesField(fieldNumber, value, { omitEmpty = true } = {}) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
  if (omitEmpty && bytes.length === 0) return Buffer.alloc(0)
  return Buffer.concat([
    encodeVarint(BigInt(fieldNumber * 8 + 2)),
    encodeVarint(BigInt(bytes.length)),
    bytes,
  ])
}

function encodeStringField(fieldNumber, value) {
  if (typeof value !== 'string') throw new ProofError('invalid-transaction-result-string')
  return encodeBytesField(fieldNumber, Buffer.from(value, 'utf8'))
}

function encodeEnum(value, values, label) {
  if (Number.isInteger(value) && value >= 0 && value <= 0x7fffffff) return BigInt(value)
  if (typeof value === 'string' && /^(0|[1-9][0-9]{0,9})$/.test(value)) return BigInt(value)
  if (typeof value === 'string' && Object.hasOwn(values, value)) return BigInt(values[value])
  throw new ProofError('unsupported-' + label)
}

const RESULT_CODE = Object.freeze({ SUCESS: 0, SUCCESS: 0, FAILED: 1 })
const CONTRACT_RESULT = Object.freeze({
  DEFAULT: 0,
  SUCCESS: 1,
  REVERT: 2,
  BAD_JUMP_DESTINATION: 3,
  OUT_OF_MEMORY: 4,
  PRECOMPILED_CONTRACT: 5,
  STACK_TOO_SMALL: 6,
  STACK_TOO_LARGE: 7,
  ILLEGAL_OPERATION: 8,
  STACK_OVERFLOW: 9,
  OUT_OF_ENERGY: 10,
  OUT_OF_TIME: 11,
  JVM_STACK_OVER_FLOW: 12,
  UNKNOWN: 13,
  TRANSFER_FAILED: 14,
  INVALID_CODE: 15,
})

const RESULT_KEYS = new Set([
  'fee', 'ret', 'contractRet', 'assetIssueID', 'withdraw_amount',
  'unfreeze_amount', 'exchange_received_amount', 'exchange_inject_another_amount',
  'exchange_withdraw_another_amount', 'exchange_id', 'shielded_transaction_fee',
  'orderId', 'orderDetails', 'withdraw_expire_amount', 'cancel_unfreezeV2_amount',
  'cancelUnfreezeV2Amount',
])

function encodeMarketOrderDetail(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new ProofError('invalid-transaction-order-detail')
  }
  const maker = bytesFromHex(item.makerOrderId || '', 'transaction-order-id', { required: false })
  const taker = bytesFromHex(item.takerOrderId || '', 'transaction-order-id', { required: false })
  const makerField = encodeBytesField(1, maker)
  const takerField = encodeBytesField(2, taker)
  const sellField = encodeVarintField(3, item.fillSellQuantity ?? 0)
  const buyField = encodeVarintField(4, item.fillBuyQuantity ?? 0)
  return Buffer.concat([makerField, takerField, sellField, buyField])
}

function encodeTransactionResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new ProofError('invalid-transaction-result')
  }
  for (const key of Object.keys(result)) {
    if (!RESULT_KEYS.has(key)) throw new ProofError('unsupported-transaction-result-field')
  }
  const fields = [
    encodeVarintField(1, result.fee ?? 0),
    encodeVarintField(2, encodeEnum(result.ret ?? 0, RESULT_CODE, 'transaction-result-code')),
    encodeVarintField(3, encodeEnum(result.contractRet ?? 0, CONTRACT_RESULT, 'contract-result-code')),
    result.assetIssueID === undefined ? Buffer.alloc(0) : encodeStringField(14, result.assetIssueID),
    encodeVarintField(15, result.withdraw_amount ?? 0),
    encodeVarintField(16, result.unfreeze_amount ?? 0),
    encodeVarintField(18, result.exchange_received_amount ?? 0),
    encodeVarintField(19, result.exchange_inject_another_amount ?? 0),
    encodeVarintField(20, result.exchange_withdraw_another_amount ?? 0),
    encodeVarintField(21, result.exchange_id ?? 0),
    encodeVarintField(22, result.shielded_transaction_fee ?? 0),
  ]
  if (result.orderId !== undefined) {
    fields.push(encodeBytesField(25, bytesFromHex(result.orderId, 'transaction-order-id', { required: false })))
  }
  if (result.orderDetails !== undefined) {
    if (!Array.isArray(result.orderDetails)) throw new ProofError('invalid-transaction-order-details')
    for (const item of result.orderDetails) fields.push(encodeBytesField(26, encodeMarketOrderDetail(item), { omitEmpty: false }))
  }
  fields.push(encodeVarintField(27, result.withdraw_expire_amount ?? 0))
  const map = result.cancel_unfreezeV2_amount ?? result.cancelUnfreezeV2Amount
  if (map !== undefined && map !== null) {
    if (!map || typeof map !== 'object' || Array.isArray(map) || Object.keys(map).length > 0) {
      // A JSON object does not preserve protobuf map iteration order reliably enough
      // for an exact byte-for-byte transaction root reconstruction.
      throw new ProofError('unsupported-transaction-result-map')
    }
  }
  return Buffer.concat(fields)
}

/**
 * Reconstructs the exact protobuf Transaction message used by java-tron
 * BlockCapsule.calcMerkleRoot(): raw_data field 1, signature fields 2, ret fields 5.
 */
export function serializeTronBlockTransaction(transaction) {
  if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) {
    throw new ProofError('invalid-block-transaction')
  }
  const rawData = bytesFromHex(transaction.raw_data_hex, 'transaction-raw-data')
  if (!Array.isArray(transaction.signature) || transaction.signature.length < 1
    || transaction.signature.length > 16) {
    throw new ProofError('transaction-signatures-missing-or-invalid')
  }
  const fields = [encodeBytesField(1, rawData, { omitEmpty: false })]
  for (const signature of transaction.signature) {
    const bytes = bytesFromHex(signature, 'transaction-signature', { exactBytes: 65 })
    fields.push(encodeBytesField(2, bytes, { omitEmpty: false }))
  }
  if (transaction.ret !== undefined) {
    if (!Array.isArray(transaction.ret) || transaction.ret.length > 16) {
      throw new ProofError('invalid-transaction-ret-list')
    }
    for (const result of transaction.ret) {
      fields.push(encodeBytesField(5, encodeTransactionResult(result), { omitEmpty: false }))
    }
  }
  return Buffer.concat(fields)
}

/**
 * TRON java-tron hashes each serialized Transaction protobuf, then combines
 * adjacent 32-byte hashes with SHA-256(left || right); an odd final node is
 * promoted unchanged to the next level.
 */
export function calculateTronTransactionMerkleRoot(transactions) {
  if (!Array.isArray(transactions)) throw new ProofError('block-transactions-missing')
  if (transactions.length === 0) return Buffer.alloc(32)

  let level = transactions.map((transaction) => sha256(serializeTronBlockTransaction(transaction)))
  while (level.length > 1) {
    const next = []
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index]
      const right = level[index + 1]
      next.push(right ? sha256(Buffer.concat([left, right])) : left)
    }
    level = next
  }
  return level[0]
}

function serializeBlockHeaderRaw(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProofError('block-header-raw-data-missing')
  }
  const timestamp = toBigInt(raw.timestamp, 'block-timestamp', { allowZero: false })
  const number = toBigInt(raw.number, 'block-number', { allowZero: false })
  const witnessId = toBigInt(raw.witness_id ?? 0, 'block-witness-id')
  const version = toBigInt(raw.version ?? 0, 'block-version')
  if (version > 0x7fffffffn) throw new ProofError('invalid-block-version')

  const txTrieRoot = bytesFromHex(raw.txTrieRoot, 'block-transaction-root', { exactBytes: 32 })
  const parentHash = bytesFromHex(raw.parentHash, 'block-parent-hash', { exactBytes: 32 })
  const witnessAddress = bytesFromHex(raw.witness_address, 'block-witness-address', { exactBytes: 21 })
  const accountStateRoot = bytesFromHex(raw.accountStateRoot || '', 'block-account-state-root', {
    required: false,
    exactBytes: 32,
  })

  return {
    bytes: Buffer.concat([
      encodeVarintField(1, timestamp),
      encodeBytesField(2, txTrieRoot, { omitEmpty: false }),
      encodeBytesField(3, parentHash, { omitEmpty: false }),
      encodeVarintField(7, number),
      encodeVarintField(8, witnessId),
      encodeBytesField(9, witnessAddress, { omitEmpty: false }),
      encodeVarintField(10, version),
      encodeBytesField(11, accountStateRoot),
    ]),
    number,
    timestamp,
    txTrieRoot,
    witnessAddress,
  }
}

function recoverWitnessAddress(rawDataHash, signatureHex) {
  const signatureBytes = bytesFromHex(signatureHex, 'block-witness-signature', { exactBytes: 65 })
  const recovery = signatureBytes[64]
  if (![0, 1, 27, 28].includes(recovery)) throw new ProofError('block-witness-signature-recovery-id-invalid')
  const v = recovery < 2 ? recovery + 27 : recovery
  const normalizedSignature = Buffer.concat([
    signatureBytes.subarray(0, 64),
    Buffer.from([v]),
  ])
  let recovered
  try {
    recovered = recoverAddress(
      '0x' + rawDataHash.toString('hex'),
      '0x' + normalizedSignature.toString('hex'),
    )
  } catch {
    throw new ProofError('block-witness-signature-invalid')
  }
  return Buffer.from('41' + recovered.slice(2), 'hex')
}

/**
 * Independently checks a TRON block's protobuf header hash, block ID,
 * Super Representative ECDSA signature and complete transaction Merkle root.
 * This verifies content integrity; it does not itself prove DPoS finality.
 */
export function verifyTronSolidifiedBlock(block, expectedNumber) {
  try {
    const header = block?.block_header
    if (!header || typeof header !== 'object') throw new ProofError('block-header-missing')
    const serialized = serializeBlockHeaderRaw(header.raw_data)
    if (serialized.number !== BigInt(expectedNumber)) throw new ProofError('block-height-mismatch')

    const digest = sha256(serialized.bytes)
    const numberPrefix = Buffer.alloc(8)
    numberPrefix.writeBigUInt64BE(serialized.number)
    const computedBlockId = Buffer.concat([numberPrefix, digest.subarray(8)]).toString('hex')
    if (typeof block.blockID !== 'string' || !HASH_HEX.test(block.blockID)
      || computedBlockId !== block.blockID.toLowerCase()) {
      throw new ProofError('block-id-does-not-match-protobuf-header')
    }

    const computedRoot = calculateTronTransactionMerkleRoot(block.transactions)
    if (!computedRoot.equals(serialized.txTrieRoot)) {
      throw new ProofError('block-transaction-merkle-root-mismatch')
    }

    const witnessAddress = recoverWitnessAddress(digest, header.witness_signature)
    if (!witnessAddress.equals(serialized.witnessAddress)) {
      throw new ProofError('block-witness-signature-address-mismatch')
    }

    return {
      verified: true,
      blockNumber: Number(serialized.number),
      blockId: computedBlockId,
      blockRawDataHash: digest.toString('hex'),
      witnessAddress: serialized.witnessAddress.toString('hex'),
      transactionMerkleRoot: computedRoot.toString('hex'),
      transactionCount: block.transactions.length,
      witnessSignatureVerified: true,
      transactionMerkleRootVerified: true,
      method: 'protobuf-block-header-sha256-witness-ecdsa-and-java-tron-transaction-merkle-recalculation',
    }
  } catch (error) {
    return {
      verified: false,
      reason: error instanceof ProofError ? error.code : 'block-cryptographic-proof-invalid',
    }
  }
}
