import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { createRippleCustodyRouter } from '../server/routes/ripple-custody.mjs'

async function withServer(app, callback) {
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try { await callback('http://127.0.0.1:' + server.address().port) }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
}

test('Ripple admin routes require the existing owner session and Origin', async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/ripple-custody', createRippleCustodyRouter({
    env: { OWNER_WALLET_ADDRESS: 'T' + 'A'.repeat(33) },
    getSession: async () => ({ success: true, session: null }),
  }))
  await withServer(app, async (base) => {
    const response = await fetch(base + '/api/ripple-custody/status')
    assert.equal(response.status, 401)
  })
})

test('Ripple withdrawal and intent-approval routes are hard-disabled before provider access', async () => {
  let providerCalls = 0
  const origin = 'https://owner.example'
  const app = express()
  app.use(express.json())
  app.use('/api/ripple-custody', createRippleCustodyRouter({
    env: { OWNER_WALLET_ADDRESS: 'T' + 'A'.repeat(33) },
    getSession: async ({ origin: suppliedOrigin }) => ({
      success: true,
      session: { network: 'mainnet', origin: suppliedOrigin, address: 'T' + 'A'.repeat(33) },
    }),
    clientFactory: () => { providerCalls += 1; throw new Error('provider must not be called') },
  }))
  await withServer(app, async (base) => {
    for (const path of ['/api/ripple-custody/intents/approve', '/api/ripple-custody/domains/d/omnibus/o/tenants/t/withdrawals']) {
      const response = await fetch(base + path, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + 'a'.repeat(43), origin, 'content-type': 'application/json' },
        body: '{}',
      })
      assert.equal(response.status, 503)
      assert.equal((await response.json()).realValueExecutionEnabled, false)
    }
  })
  assert.equal(providerCalls, 0)
})

