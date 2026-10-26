import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { TronWeb, utils } from 'tronweb'

const protobufPackage = JSON.parse(await readFile(
  new URL('../node_modules/google-protobuf/package.json', import.meta.url),
  'utf8',
))

test('uses the patched google-protobuf runtime', () => {
  assert.equal(protobufPackage.version, '4.0.3')
})

test('TronWeb can build, decode and locally sign a TRC-20 draft with patched protobuf', async () => {
  // Fully local fixture: explicit synthetic block-header fields avoid reference
  // block lookup, txLocal avoids contract simulation, and this test never calls
  // sendRawTransaction or broadcasts the generated transaction.
  const tronWeb = new TronWeb({ fullHost: 'http://127.0.0.1:1' })
  const sender = await tronWeb.createAccount()
  const receiver = await tronWeb.createAccount()
  const contractAddress = 'TU1ntBzpGPp7GJkzxLTKwYsneJ9JKUmBCK'
  const amountBaseUnits = '1234567'
  const timestamp = Date.now()

  const built = await tronWeb.transactionBuilder.triggerSmartContract(
    contractAddress,
    'transfer(address,uint256)',
    {
      txLocal: true,
      blockHeader: {
        ref_block_bytes: '0001',
        ref_block_hash: '0000000000000001',
        expiration: timestamp + 60_000,
        timestamp,
      },
      tokenId: '1000008',
      tokenValue: 100,
      feeLimit: 100 * 10 ** 6,
      callValue: 0,
      from: sender.address.base58,
      shouldPollResponse: false,
    },
    [
      { type: 'address', value: receiver.address.base58 },
      { type: 'uint256', value: amountBaseUnits },
    ],
    sender.address.base58,
  )

  assert.equal(built?.result?.result, true)
  assert.equal(typeof built.transaction?.raw_data_hex, 'string')
  assert.match(built.transaction.raw_data_hex, /^(?:[0-9a-f]{2})+$/i)
  assert.match(built.transaction.txID, /^[0-9a-f]{64}$/i)

  const decoded = utils.deserializeTx.deserializeTransaction(
    'TriggerSmartContract',
    built.transaction.raw_data_hex,
  )
  const value = decoded.contract[0].parameter.value

  assert.equal(value.owner_address, sender.address.hex)
  assert.equal(
    value.contract_address,
    utils.address.toHex(contractAddress).toUpperCase(),
  )
  assert.equal(value.data.slice(0, 8).toLowerCase(),
    utils.ethersUtils.keccak256(
      new TextEncoder().encode('transfer(address,uint256)'),
    ).toString().slice(2, 10).toLowerCase())

  const decodedParameters = new utils.ethersUtils.AbiCoder().decode(
    ['address', 'uint256'],
    '0x' + value.data.slice(8),
  )
  const decodedReceiver = tronWeb.address.fromHex(
    '41' + String(decodedParameters[0]).replace(/^0x/i, ''),
  )
  assert.equal(decodedReceiver, receiver.address.base58)
  assert.equal(String(decodedParameters[1]), amountBaseUnits)

  // Signing is local and uses an ephemeral in-memory test key; do not broadcast.
  const signed = await tronWeb.trx.sign(
    { ...built.transaction, raw_data: decoded },
    sender.privateKey,
  )
  assert.equal(Array.isArray(signed.signature), true)
  assert.equal(signed.signature.length, 1)
  assert.match(signed.signature[0], /^[0-9a-f]{130}$/i)
  assert.equal(signed.txID, built.transaction.txID)
})
