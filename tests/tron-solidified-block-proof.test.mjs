import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { SigningKey, computeAddress } from 'ethers'
import {
  calculateTronTransactionMerkleRoot,
  serializeTronBlockTransaction,
  verifyTronSolidifiedBlock,
} from '../server/tron-solidified-block-proof.mjs'

const signingKey = new SigningKey('0x' + '11'.repeat(32))

function varint(value) {
  let remaining = BigInt.asUintN(64, BigInt(value))
  const output = []
  while (remaining > 127n) {
    output.push(Number((remaining & 127n) | 128n))
    remaining >>= 7n
  }
  output.push(Number(remaining))
  return Buffer.from(output)
}

function varintField(field, value) {
  return BigInt(value) === 0n ? Buffer.alloc(0)
    : Buffer.concat([varint(BigInt(field * 8)), varint(value)])
}

function bytesField(field, value) {
  const bytes = Buffer.from(value)
  return Buffer.concat([varint(BigInt(field * 8 + 2)), varint(bytes.length), bytes])
}

function testTransaction(rawData, signatureByte, ret = undefined) {
  const rawDataBytes = Buffer.from(rawData, 'hex')
  const transaction = {
    txID: createHash('sha256').update(rawDataBytes).digest('hex'),
    raw_data_hex: rawData,
    raw_data: { contract: [{ type: 'TransferContract', parameter: { value: {} } }] },
    signature: [Buffer.alloc(65, signatureByte).toString('hex')],
    ...(ret === undefined ? {} : { ret }),
  }
  // This helper independently encodes the protobuf Transaction used by the
  // reference java-tron MerkleTree algorithm for the limited fixture fields.
  const fields = [bytesField(1, rawDataBytes), bytesField(2, Buffer.from(transaction.signature[0], 'hex'))]
  if (ret !== undefined) {
    for (const result of ret) {
      const resultFields = [
        varintField(1, result.fee || 0),
        varintField(3, result.contractRet === 'SUCCESS' ? 1 : 0),
      ]
      fields.push(bytesField(5, Buffer.concat(resultFields)))
    }
  }
  transaction.__serialized = Buffer.concat(fields)
  return transaction
}

function merkleRoot(transactions) {
  if (!transactions.length) return Buffer.alloc(32)
  let level = transactions.map((tx) => createHash('sha256').update(tx.__serialized).digest())
  while (level.length > 1) {
    const next = []
    for (let i = 0; i < level.length; i += 2) {
      next.push(level[i + 1]
        ? createHash('sha256').update(Buffer.concat([level[i], level[i + 1]])).digest()
        : level[i])
    }
    level = next
  }
  return level[0]
}

function headerBytes(raw) {
  return Buffer.concat([
    varintField(1, raw.timestamp),
    bytesField(2, Buffer.from(raw.txTrieRoot, 'hex')),
    bytesField(3, Buffer.from(raw.parentHash, 'hex')),
    varintField(7, raw.number),
    varintField(9, Buffer.from(raw.witness_address, 'hex').length ? BigInt(0) : 0n),
    bytesField(9, Buffer.from(raw.witness_address, 'hex')),
    varintField(10, raw.version || 0),
    ...(raw.accountStateRoot ? [bytesField(11, Buffer.from(raw.accountStateRoot, 'hex'))] : []),
  ])
}

function makeBlock(number, transactions, { badWitness = false, badMerkle = false, accountStateRoot = false } = {}) {
  const root = merkleRoot(transactions).toString('hex')
  const raw = {
    timestamp: number * 3000,
    txTrieRoot: (badMerkle ? 'ff'.repeat(32) : root),
    parentHash: '00'.repeat(32),
    number,
    witness_id: 0,
    witness_address: '41' + computeAddress(signingKey.publicKey).slice(2),
    version: 1,
    ...(accountStateRoot ? { accountStateRoot: '22'.repeat(32) } : {}),
  }
  const bytes = headerBytes(raw)
  const digest = createHash('sha256').update(bytes).digest()
  const prefix = Buffer.alloc(8)
  prefix.writeBigUInt64BE(BigInt(number))
  const blockID = Buffer.concat([prefix, digest.subarray(8)]).toString('hex')
  const signed = signingKey.sign('0x' + digest.toString('hex')).serialized
  const witnessSignature = badWitness ? '00'.repeat(65) : signed.slice(2)
  return {
    blockID,
    block_header: { raw_data: raw, witness_signature: witnessSignature },
    transactions: transactions.map(({ __serialized, ...tx }) => tx),
  }
}

test('verifies a block header hash, recovered witness signature and full transaction Merkle root', () => {
  const transactions = [
    testTransaction('0a0101', 0x11),
    testTransaction('0a0102', 0x22, [{ fee: 1000, contractRet: 'SUCCESS' }]),
    testTransaction('0a0103', 0x33),
  ]
  const block = makeBlock(12345, transactions, { accountStateRoot: true })
  const result = verifyTronSolidifiedBlock(block, 12345)

  assert.equal(result.verified, true, JSON.stringify(result))
  assert.equal(result.blockId, block.blockID)
  assert.equal(result.witnessSignatureVerified, true)
  assert.equal(result.transactionMerkleRootVerified, true)
  assert.equal(result.transactionCount, 3)
})

test('matches the java-tron single-leaf transaction root semantics', () => {
  const transaction = testTransaction('0a0101', 0x44)
  const expected = createHash('sha256').update(transaction.__serialized).digest()
  assert.deepEqual(
    calculateTronTransactionMerkleRoot([transaction]).toString('hex'),
    expected.toString('hex'),
  )
})

test('rejects a composite block ID that does not match the serialized header', () => {
  const block = makeBlock(12346, [testTransaction('0a0101', 0x11)])
  block.blockID = 'ff' + block.blockID.slice(2)
  assert.equal(verifyTronSolidifiedBlock(block, 12346).reason, 'block-id-does-not-match-protobuf-header')
})

test('rejects a changed transaction list or transaction root', () => {
  const tx = testTransaction('0a0101', 0x11)
  const block = makeBlock(12347, [tx], { badMerkle: true })
  assert.equal(verifyTronSolidifiedBlock(block, 12347).reason, 'block-transaction-merkle-root-mismatch')
})

test('rejects an invalid witness signature', () => {
  const block = makeBlock(12348, [testTransaction('0a0101', 0x11)], { badWitness: true })
  assert.equal(verifyTronSolidifiedBlock(block, 12348).verified, false)
})

test('rejects a transaction without all signature bytes required for protobuf reconstruction', () => {
  const block = makeBlock(12349, [testTransaction('0a0101', 0x11)])
  block.transactions[0].signature = []
  assert.equal(verifyTronSolidifiedBlock(block, 12349).reason, 'transaction-signatures-missing-or-invalid')
})

test('refuses to reconstruct unknown transaction result fields instead of guessing byte encoding', () => {
  const transaction = testTransaction('0a0101', 0x11, [{ unexpectedField: 5 }])
  const block = makeBlock(12350, [transaction])
  assert.equal(verifyTronSolidifiedBlock(block, 12350).reason, 'unsupported-transaction-result-field')
})

test('exposes the protobuf transaction serialization used by the Merkle calculation', () => {
  const transaction = testTransaction('0a0101', 0x11)
  assert.deepEqual(
    serializeTronBlockTransaction(transaction),
    transaction.__serialized,
  )
})
