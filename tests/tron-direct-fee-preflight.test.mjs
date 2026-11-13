import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  estimateDirectSignedTransactionBytes,
  directPayoutTransactionMatches,
} from '../server/routes/tron-direct-fee-preflight.mjs'

const ownerHex = '41' + '1'.repeat(40)
const routerHex = '41' + '2'.repeat(40)
const selector = '12345678'
const args = '3'.repeat(64) + '4'.repeat(64) + '5'.repeat(64) + '6'.repeat(64)
const rawDataHex = '0a' + '01'
const txID = createHash('sha256').update(Buffer.from(rawDataHex, 'hex')).digest('hex')
const transaction = {
  txID,
  raw_data_hex: rawDataHex,
  raw_data: {
    expiration: Date.now() + 60_000,
    fee_limit: 1000000,
    contract: [{
      type: 'TriggerSmartContract',
      parameter: {
        value: {
          owner_address: ownerHex,
          contract_address: routerHex,
          call_value: 0,
          data: selector + args,
        },
      },
    }],
  },
}

test('direct payout unsigned transaction must match owner, router, exact calldata and be unsigned', () => {
  assert.equal(directPayoutTransactionMatches(transaction, {
    ownerHex, routerHex, parameter: { selector, arguments: args }, feeLimitSun: '1000000',
  }), true)

  const wrongOwner = structuredClone(transaction)
  wrongOwner.raw_data.contract[0].parameter.value.owner_address = '41' + '9'.repeat(40)
  assert.equal(directPayoutTransactionMatches(wrongOwner, {
    ownerHex, routerHex, parameter: { selector, arguments: args }, feeLimitSun: '1000000',
  }), false)

  const wrongCall = structuredClone(transaction)
  wrongCall.raw_data.contract[0].parameter.value.data = selector + 'f'.repeat(128)
  assert.equal(directPayoutTransactionMatches(wrongCall, {
    ownerHex, routerHex, parameter: { selector, arguments: args }, feeLimitSun: '1000000',
  }), false)

  const alreadySigned = { ...structuredClone(transaction), signature: ['b'.repeat(130)] }
  assert.equal(directPayoutTransactionMatches(alreadySigned, {
    ownerHex, routerHex, parameter: { selector, arguments: args }, feeLimitSun: '1000000',
  }), false)
})

test('direct signed-byte estimate includes transaction envelope and 65-byte owner signature', () => {
  const bytes = estimateDirectSignedTransactionBytes('aa'.repeat(100))
  assert.equal(bytes, 100 + 1 + 1 + 1 + 1 + 65)
  assert.throws(() => estimateDirectSignedTransactionBytes('abc'), /length|invalid/i)
})

import express from 'express'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createTronDirectFeePreflightRouter } from '../server/routes/tron-direct-fee-preflight.mjs'

test('direct preflight has no sponsor-wallet configuration dependency', async () => {
  const source = await readFile(new URL('../server/routes/tron-direct-fee-preflight.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /SPONSOR_[A-Z_]+_ADDRESS|feeSponsorAddress|assetSponsorAddress/)
})

test('direct owner fee-preflight requires the private owner session and makes no provider call before authentication', async (t) => {
  let providerCalls = 0
  const app = express()
  app.use(express.json())
  app.use('/api/tron', createTronDirectFeePreflightRouter({
    env: {
      FRONTEND_ORIGIN: 'https://owner.example',
      OWNER_WALLET_ADDRESS: 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp',
    },
    fetchImpl: async () => { providerCalls += 1; throw new Error('must-not-call-provider') },
  }))
  const server = app.listen(0, '127.0.0.1')
  t.after(() => new Promise((resolve) => server.close(resolve)))
  await once(server, 'listening')
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/tron/direct-fee-preflight', {
    method: 'POST',
    headers: {
      Origin: 'https://owner.example',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      recipientAddress: 'TKmwZgALZPatKVJpcAx93XVNu6DiaauPFk',
      nativeTrxAmountSun: '1000000',
      traxAmountBaseUnits: '100000000',
      payoutReference: '0x' + '1'.repeat(64),
    }),
  })
  assert.equal(response.status, 401)
  assert.equal((await response.json()).error, 'owner-session-required')
  assert.equal(providerCalls, 0)
})
