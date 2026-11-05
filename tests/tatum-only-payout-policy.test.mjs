import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createTronTransferRouter } from '../server/routes/tron-transfer.mjs'

async function withServer(run) {
  const app = express()
  app.use(express.json({ limit: '32kb' }))
  app.use('/api/tron-transfer', createTronTransferRouter({ env: {} }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api/tron-transfer`
  try {
    await run(base)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

test('Tatum-only policy rejects legacy Fincra sponsor-request intake before authentication or database access', async () => {
  await withServer(async (base) => {
    const response = await fetch(base + '/sponsor-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requesterAddress: 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp',
        recipientAddress: 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp',
        amount: '1',
      }),
    })
    const payload = await response.json()
    assert.equal(response.status, 410)
    assert.equal(payload.error, 'legacy-fincra-sponsor-intake-disabled')
    assert.equal(payload.payoutProvider, 'tatum')
    assert.equal(payload.transactionSubmitted, false)
  })
})

test('Tatum-only policy rejects the legacy live Fincra payout endpoint even if provider credentials are supplied', async () => {
  await withServer(async (base) => {
    const response = await fetch(base + '/sponsor-requests/00000000-0000-4000-8000-000000000001/fincra-payout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const payload = await response.json()
    assert.equal(response.status, 410)
    assert.equal(payload.error, 'legacy-fincra-payout-disabled')
    assert.equal(payload.payoutProvider, 'tatum')
    assert.equal(payload.transactionSubmitted, false)
    assert.equal(payload.submissionEnabled, false)
  })
})
