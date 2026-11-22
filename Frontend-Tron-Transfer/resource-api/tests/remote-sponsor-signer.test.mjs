import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { createRemoteSponsorSigner } from '../remote-sponsor-signer.mjs'

const secret = 's'.repeat(48)
const address = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const transaction = {
  txID: createHash('sha256').update(Buffer.from('ab'.repeat(40), 'hex')).digest('hex'),
  raw_data_hex: 'ab'.repeat(40),
  raw_data: { expiration: 123456789, contract: [{ type: 'FreezeBalanceV2Contract', parameter: { value: { amount: 1 } } }] },
}
const mac = value => createHmac('sha256', secret).update(value).digest('hex')
const env = {
  SPONSOR_SIGNER_URL: 'https://signer.example.test/v1/sign',
  SPONSOR_SIGNER_HMAC_SECRET: secret,
  SPONSOR_MAINNET_ADDRESS: address,
}

test('remote signer authenticates request and accepts only matching signed transaction response', async () => {
  let request
  const signer = createRemoteSponsorSigner({
    env, now: () => 1700000000000, requestId: () => 'request-123',
    fetchImpl: async (url, options) => {
      request = { url, options }
      const signedTransaction = { ...transaction, signature: ['c'.repeat(130)] }
      return {
        ok: true,
        async json() {
          return {
            requestId: 'request-123',
            signedTransaction,
            responseMac: mac(['request-123', signedTransaction.txID, signedTransaction.raw_data_hex, signedTransaction.signature.join(',')].join('.')),
          }
        },
      }
    },
  })
  assert.equal(signer.readiness().configured, true)
  const signed = await signer.signTransaction(transaction)
  assert.deepEqual(signed.signature, ['c'.repeat(130)])
  assert.equal(request.url, env.SPONSOR_SIGNER_URL)
  assert.equal(request.options.redirect, 'error', 'signer authentication must never follow redirects')
  const expected = mac(['1700000000000', 'request-123', request.options.body].join('.'))
  assert.equal(request.options.headers['x-sponsor-signer-signature'], expected)
  assert.equal(request.options.headers['x-sponsor-signer-request-id'], 'request-123')
})

test('remote signer rejects transaction mutation and unauthenticated responses', async () => {
  const signer = createRemoteSponsorSigner({
    env, requestId: () => 'request-456',
    fetchImpl: async () => ({
      ok: true,
      async json() {
        const signedTransaction = { ...transaction, raw_data_hex: 'ff'.repeat(40), signature: ['c'.repeat(130)] }
        return { requestId: 'request-456', signedTransaction, responseMac: '0'.repeat(64) }
      },
    }),
  })
  await assert.rejects(() => signer.signTransaction(transaction), /response-integrity-failed/)
})

test('remote signer fails closed for HTTP and invalid transport configuration', async () => {
  const badUrl = createRemoteSponsorSigner({ env: { ...env, SPONSOR_SIGNER_URL: 'http://signer.example.test' } })
  assert.equal(badUrl.readiness().configured, false)
  await assert.rejects(() => badUrl.signTransaction(transaction), /not-configured/)
  const unavailable = createRemoteSponsorSigner({
    env,
    fetchImpl: async () => ({ ok: false, status: 503 }),
  })
  await assert.rejects(() => unavailable.signTransaction(transaction), /http-503/)
})

test('remote signer rejects malformed transaction before network request', async () => {
  let calls = 0
  const signer = createRemoteSponsorSigner({ env, fetchImpl: async () => { calls += 1 } })
  await assert.rejects(() => signer.signTransaction({ ...transaction, txID: 'bad' }), /invalid-transaction/)
  assert.equal(calls, 0)
})

test('remote signer rejects a transaction ID that does not hash to its raw transaction bytes', async () => {
  let calls = 0
  const signer = createRemoteSponsorSigner({
    env,
    fetchImpl: async () => { calls += 1; throw new Error('network must not be called') },
  })
  await assert.rejects(
    () => signer.signTransaction({ ...transaction, txID: 'f'.repeat(64) }),
    /transaction-id-mismatch/,
  )
  assert.equal(calls, 0)
})
