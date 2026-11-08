import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { TronWeb } from 'tronweb'
import express from 'express'
import { createServer } from 'node:http'
import {
  MAINNET_USDT_CONTRACT,
  MIN_OWNER_WITHDRAWAL_USDT_BASE_UNITS,
  isOwnerWithdrawalAmountAtLeastMinimum,
  parseOwnerUsdtAmount,
  calculateOwnerWithdrawableUsdtBaseUnits,
  buildOwnerUsdtTransferParameter,
  validateOwnerSignedTransaction,
  assessOwnerRecipientAssurance,
  createTronOwnerWithdrawalsRouter,
} from '../server/routes/tron-owner-withdrawals.mjs'

const ownerAddress = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'
const recipientAddress = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const tronWeb = new TronWeb({ fullHost: 'https://tron-mainnet.gateway.tatum.io' })

test('owner USDT amount parser converts exact six-decimal base units', () => {
  assert.equal(parseOwnerUsdtAmount('1'), '1000000')
  assert.equal(parseOwnerUsdtAmount('12.340056'), '12340056')
  assert.equal(parseOwnerUsdtAmount('0.000001'), '1')
})


test('owner withdrawal minimum is exactly 1,000 USDT and is isolated from the shared amount parser', () => {
  assert.equal(MIN_OWNER_WITHDRAWAL_USDT_BASE_UNITS, '1000000000')
  assert.equal(isOwnerWithdrawalAmountAtLeastMinimum('999999999'), false)
  assert.equal(isOwnerWithdrawalAmountAtLeastMinimum('1000000000'), true)
  assert.equal(isOwnerWithdrawalAmountAtLeastMinimum('1000000001'), true)
  assert.equal(isOwnerWithdrawalAmountAtLeastMinimum('not-an-integer'), false)
  // The shared parser remains generic because the legacy sponsor adapter imports it;
  // only the owner-withdrawal preparation route applies the platform minimum.
  assert.equal(parseOwnerUsdtAmount('999.999999'), '999999999')
})

test('owner USDT amount parser rejects zero, excess precision and non-decimal values', () => {
  for (const value of ['0', '0.000000', '0.0000001', '-1', '1e2', '01', '1,000', 1]) {
    assert.throws(() => parseOwnerUsdtAmount(value))
  }
})

test('available USDT subtracts active reservations without allowing a negative result', () => {
  assert.equal(calculateOwnerWithdrawableUsdtBaseUnits('100000000', '25000000'), '75000000')
  assert.equal(calculateOwnerWithdrawableUsdtBaseUnits('1000000', '1000000'), '0')
  assert.equal(calculateOwnerWithdrawableUsdtBaseUnits('1000000', '2000000'), '0')
  assert.throws(() => calculateOwnerWithdrawableUsdtBaseUnits('-1', '0'))
  assert.throws(() => calculateOwnerWithdrawableUsdtBaseUnits('100', '1.5'))
})

test('TRC20 ABI parameter encodes recipient and six-decimal amount exactly', () => {
  const parameter = buildOwnerUsdtTransferParameter(recipientAddress, '1234567', tronWeb)
  assert.equal(parameter.length, 128)
  assert.match(parameter, /^[0-9a-f]{128}$/)
  const recipientBytes = tronWeb.address.toHex(recipientAddress).replace(/^41/i, '').toLowerCase()
  assert.equal(parameter.slice(24, 64), recipientBytes)
  assert.equal(BigInt('0x' + parameter.slice(64)).toString(), '1234567')
  assert.throws(() => buildOwnerUsdtTransferParameter('not-an-address', '1', tronWeb))
  assert.throws(() => buildOwnerUsdtTransferParameter(recipientAddress, '0', tronWeb))
})

function preparedTransfer(overrides = {}) {
  const amountBaseUnits = MIN_OWNER_WITHDRAWAL_USDT_BASE_UNITS
  const parameter = buildOwnerUsdtTransferParameter(recipientAddress, amountBaseUnits, tronWeb)
  const rawData = {
    contract: [{
      type: 'TriggerSmartContract',
      parameter: {
        value: {
          owner_address: tronWeb.address.toHex(ownerAddress),
          contract_address: tronWeb.address.toHex(MAINNET_USDT_CONTRACT),
          call_value: 0,
          data: 'a9059cbb' + parameter,
        },
      },
    }],
    expiration: Date.now() + 5 * 60 * 1000,
    timestamp: Date.now(),
  }
  const rawDataHex = 'deadbeef'
  const txID = createHash('sha256').update(Buffer.from(rawDataHex, 'hex')).digest('hex')
  const unsigned = {
    txID,
    raw_data_hex: rawDataHex,
    raw_data: rawData,
  }
  const signed = { ...unsigned, signature: ['a'.repeat(130)] }
  return {
    unsigned,
    signed,
    intent: { ownerAddress, recipientAddress, amountBaseUnits, tronWeb },
    ...overrides,
  }
}

test('signed withdrawal validation independently rejects amounts below the 1,000 USDT minimum', () => {
  const item = preparedTransfer()
  assert.deepEqual(validateOwnerSignedTransaction(item.signed, item.unsigned, {
    ...item.intent,
    amountBaseUnits: '999999999',
  }), { ok: false, reason: 'owner-withdrawal-below-1000-usdt-minimum' })
  assert.deepEqual(validateOwnerSignedTransaction(item.signed, item.unsigned, item.intent), { ok: true })
})

test('owner preparation route applies the minimum before database or provider access', async () => {
  const source = await readFile(new URL('../server/routes/tron-owner-withdrawals.mjs', import.meta.url), 'utf8')
  const prepareStart = source.indexOf("router.post('/prepare'")
  const broadcastStart = source.indexOf("router.post('/:id/broadcast'")
  assert.ok(prepareStart >= 0 && broadcastStart > prepareStart)
  const prepareRoute = source.slice(prepareStart, broadcastStart)
  const minimumGuard = prepareRoute.indexOf('if (!isOwnerWithdrawalAmountAtLeastMinimum(amountBaseUnits))')
  const databaseAccess = prepareRoute.indexOf('const db = getPool(env)')
  const providerAccess = prepareRoute.indexOf('tatumApiKey(env)')
  assert.ok(minimumGuard >= 0)
  assert.ok(databaseAccess > minimumGuard)
  assert.ok(providerAccess > minimumGuard)
})

test('signed withdrawal must preserve the persisted owner, recipient, contract and amount intent', () => {
  const item = preparedTransfer()
  assert.deepEqual(validateOwnerSignedTransaction(item.signed, item.unsigned, item.intent), { ok: true })
})

test('signed withdrawal rejects a changed recipient, token contract, amount or raw transaction', () => {
  const item = preparedTransfer()
  const wrongRecipient = preparedTransfer()
  wrongRecipient.signed.raw_data.contract[0].parameter.value.data =
    'a9059cbb' + buildOwnerUsdtTransferParameter(ownerAddress, item.intent.amountBaseUnits, tronWeb)
  assert.equal(validateOwnerSignedTransaction(wrongRecipient.signed, wrongRecipient.unsigned, item.intent).ok, false)

  const wrongContract = preparedTransfer()
  wrongContract.signed.raw_data.contract[0].parameter.value.contract_address = tronWeb.address.toHex(recipientAddress)
  assert.equal(validateOwnerSignedTransaction(wrongContract.signed, wrongContract.unsigned, wrongContract.intent).ok, false)

  const wrongAmount = preparedTransfer()
  wrongAmount.signed.raw_data.contract[0].parameter.value.data =
    'a9059cbb' + buildOwnerUsdtTransferParameter(recipientAddress, '25000001', tronWeb)
  assert.equal(validateOwnerSignedTransaction(wrongAmount.signed, wrongAmount.unsigned, wrongAmount.intent).ok, false)

  const changedRaw = { ...item.signed, raw_data_hex: 'cafebabe' }
  assert.equal(validateOwnerSignedTransaction(changedRaw, item.unsigned, item.intent).ok, false)
})

test('signed withdrawal rejects a missing or multiple-signature payload', () => {
  const item = preparedTransfer()
  assert.equal(validateOwnerSignedTransaction({ ...item.signed, signature: [] }, item.unsigned, item.intent).reason, 'owner-signature-required')
  assert.equal(validateOwnerSignedTransaction({ ...item.signed, signature: ['a'.repeat(130), 'b'.repeat(130)] }, item.unsigned, item.intent).reason, 'owner-signature-required')
})


test('owner-direct Mainnet broadcast is hard-disabled even before owner authentication or database access', async (t) => {
  const app=express()
  app.use(express.json())
  app.use('/api/tron/owner-withdrawals',createTronOwnerWithdrawalsRouter({env:{}}))
  const server=createServer(app)
  await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise((resolve,reject)=>server.close((error)=>error?reject(error):resolve())))
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/tron/owner-withdrawals/123e4567-e89b-42d3-a456-426614174000/broadcast',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({signedTransaction:{signature:[]}}),
  })
  const payload=await response.json()
  assert.equal(response.status,503)
  assert.equal(payload.success,false)
  assert.equal(payload.error,'owner-direct-mainnet-broadcast-disabled-in-this-build')
  assert.equal(payload.transactionBroadcast,false)
})


test('recipient assurance requires explicit TRON Mainnet TRC20 network acknowledgement', () => {
  assert.deepEqual(assessOwnerRecipientAssurance({
    ownerAddress, recipientAddress, recipientNetwork: 'TRON_MAINNET_TRC20', recipientNetworkConfirmed: true,
  }), {
    ok: true,
    recipientNetwork: 'TRON_MAINNET_TRC20',
    recipientNetworkConfirmed: true,
    exchangeCreditStatus: 'not-verifiable',
  })
  assert.equal(assessOwnerRecipientAssurance({
    ownerAddress, recipientAddress, recipientNetwork: 'ETHEREUM', recipientNetworkConfirmed: true,
  }).reason, 'recipient-network-must-be-tron-mainnet-trc20')
  assert.equal(assessOwnerRecipientAssurance({
    ownerAddress, recipientAddress, recipientNetwork: 'TRON_MAINNET_TRC20', recipientNetworkConfirmed: false,
  }).reason, 'recipient-network-confirmation-required')
  assert.equal(assessOwnerRecipientAssurance({
    ownerAddress, recipientAddress: ownerAddress, recipientNetwork: 'TRON_MAINNET_TRC20', recipientNetworkConfirmed: true,
  }).reason, 'invalid-or-self-recipient-address')
})

test('owner withdrawal code persists solidified block and event evidence separately from exchange credit status', async () => {
  const source = await readFile(new URL('../server/routes/tron-owner-withdrawals.mjs', import.meta.url), 'utf8')
  assert.match(source, /confirmation_block_number=\\$4,confirmation_event_index=\\$5,confirmation_verified_at=now\\(\\)/)
  assert.match(source, /exchangeCreditStatus: row\\.exchange_credit_status \\|\\| 'not-verifiable'/)
  assert.match(source, /REAL_OWNER_DIRECT_MAINNET_BROADCAST_DISABLED = true/)
})
