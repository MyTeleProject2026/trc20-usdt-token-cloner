import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createOwnerManagedSigner } from '../owner-managed-signer.mjs'

const owner = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const contract = 'TQn9Y2khEsLJW1ChVWFMSMeNT3h6vTq6t4'

function fakeTronWeb(options) {
  return {
    fullNode: { host: 'https://api.trongrid.io' },
    address: {
      fromPrivateKey: () => owner,
      fromHex: value => value === '41' + '22'.repeat(20) ? owner : value === '41' + '33'.repeat(20) ? contract : 'TWrong',
    },
    isAddress: value => value === owner || value === contract,
    sha3: () => '0x12345678',
    utils: { transaction: { txCheck: () => true } },
    trx: { async sign(tx) { return { ...tx, signature: ['a'.repeat(130)] } } },
  }
}
function transaction() {
  const raw = Buffer.from('01020304', 'hex')
  return {
    txID: createHash('sha256').update(raw).digest('hex'),
    raw_data_hex: raw.toString('hex'),
    raw_data: { timestamp: Date.now(), expiration: Date.now() + 60_000, fee_limit: 1000000, contract: [{
      type: 'TriggerSmartContract',
      parameter: { value: {
        owner_address: '41' + '22'.repeat(20),
        contract_address: '41' + '33'.repeat(20),
        data: '12345678',
        call_value: 0,
      } },
    }] },
  }
}
const env = {
  TRON_OWNER_PRIVATE_KEY: 'a'.repeat(64),
  TRON_OWNER_ADDRESS: owner,
  TRAX_CONTRACT_ADDRESS: contract,
}

test('Owner signer refuses missing key, address, or allowlisted contract configuration', () => {
  assert.throws(() => createOwnerManagedSigner({ env: {} }), /OWNER_SIGNER_PRIVATE_KEY_NOT_CONFIGURED_OR_INVALID/)
  assert.throws(() => createOwnerManagedSigner({ env: { ...env, TRON_OWNER_ADDRESS: 'TWrong' } }), /OWNER_SIGNER_ADDRESS_MISMATCH/)
  assert.throws(() => createOwnerManagedSigner({ env: { ...env, TRAX_CONTRACT_ADDRESS: '' } }), /OWNER_SIGNER_IDENTITY_OR_CONTRACT_NOT_CONFIGURED/)
})

test('Owner signer exposes only public identity and signs allowlisted exact contract transactions', async () => {
  const signer = createOwnerManagedSigner({ env, tronWebFactory: fakeTronWeb })
  assert.equal(signer.address, owner)
  assert.equal('privateKey' in signer, false)
  assert.equal('tronWeb' in signer, false)
  const signed = await signer.signContractTransaction(transaction())
  assert.equal(signed.signature.length, 1)
})

test('Owner signer rejects wrong transaction owner and wrong contract before signing', async () => {
  const signer = createOwnerManagedSigner({ env, tronWebFactory: fakeTronWeb })
  const wrongOwner = transaction()
  wrongOwner.raw_data.contract[0].parameter.value.owner_address = '41' + '44'.repeat(20)
  await assert.rejects(signer.signContractTransaction(wrongOwner), /OWNER_SIGNER_TRANSACTION_OWNER_MISMATCH/)
  const wrongContract = transaction()
  wrongContract.raw_data.contract[0].parameter.value.contract_address = '41' + '55'.repeat(20)
  await assert.rejects(signer.signContractTransaction(wrongContract), /OWNER_SIGNER_CONTRACT_NOT_ALLOWLISTED/)
})

test('Owner signer rejects tampered raw transaction IDs and call value', async () => {
  const signer = createOwnerManagedSigner({ env, tronWebFactory: fakeTronWeb })
  const badId = transaction()
  badId.txID = 'f'.repeat(64)
  await assert.rejects(signer.signContractTransaction(badId), /OWNER_SIGNER_TRANSACTION_ID_MISMATCH/)
  const value = transaction()
  value.raw_data.contract[0].parameter.value.call_value = 1
  await assert.rejects(signer.signContractTransaction(value), /OWNER_SIGNER_CALL_DATA_OR_VALUE_INVALID/)
})

test('Owner signer rejects expired and non-allowlisted contract method transactions', async () => {
  const signer = createOwnerManagedSigner({ env, tronWebFactory: fakeTronWeb })
  const expired = transaction()
  expired.raw_data.expiration = Date.now() - 1
  await assert.rejects(signer.signContractTransaction(expired), /OWNER_SIGNER_TRANSACTION_EXPIRED_OR_INVALID/)
  const wrongMethod = transaction()
  wrongMethod.raw_data.contract[0].parameter.value.data = 'deadbeef'
  await assert.rejects(signer.signContractTransaction(wrongMethod), /OWNER_SIGNER_METHOD_NOT_ALLOWLISTED/)
})
