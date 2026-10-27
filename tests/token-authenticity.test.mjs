import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import express from 'express'
import { createTokenAuthenticityRouter, OFFICIAL_MAINNET_USDT_CONTRACT } from '../server/routes/token-authenticity.mjs'

async function withServer({ env = {}, fetchImpl = async () => { throw new Error('unexpected upstream request') } } = {}, run) {
  const app = express()
  app.use('/api/tron', createTokenAuthenticityRouter({ env, fetchImpl, timeoutMs: 50 }))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  try { await run(baseUrl) } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

function explorerResponse(record, status = 200) {
  return new Response(JSON.stringify({ data: record ? [record] : [] }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('Mainnet scanner reports explorer source verification and token risk as separate evidence', async () => {
  let seenUrl = ''
  await withServer({
    fetchImpl: async (url) => {
      seenUrl = String(url)
      return explorerResponse({
        address: OFFICIAL_MAINNET_USDT_CONTRACT,
        verify_status: 2,
        feedbackRisk: false,
        redTag: '',
        blueTag: 'USDT',
        blueTagUrl: 'tether.to',
        creator: { address: 'THPvaUhoh2Qn2y9THCZML3H815hhFhn5YC' },
        tokenInfo: { tokenName: 'Tether USD', tokenAbbr: 'USDT', tokenType: 'trc20', tokenDecimal: '6', tokenLevel: '2' },
      })
    },
  }, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/tron/token-authenticity?network=mainnet&contract=${OFFICIAL_MAINNET_USDT_CONTRACT}`)
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.match(response.headers.get('cache-control') || '', /no-store/)
    assert.equal(new URL(seenUrl).origin, 'https://apilist.tronscanapi.com')
    assert.equal(body.success, true)
    assert.equal(body.officialMainnetUsdtAddressMatch, true)
    assert.equal(body.sourceVerificationStatus, 'fully-verified-source')
    assert.equal(body.explorerRiskLevel, 'ok')
    assert.equal(body.tokenName, 'Tether USD')
    assert.equal(body.tokenDecimals, 6)
    assert.match(body.evidenceScope, /not an audit or a guarantee/)
  })
})

test('testnet token evidence never borrows Mainnet explorer verification', async () => {
  let calls = 0
  await withServer({ fetchImpl: async () => { calls += 1; return explorerResponse(null) } }, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/tron/token-authenticity?network=nile&contract=${OFFICIAL_MAINNET_USDT_CONTRACT}`)
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.explorerStatus, 'not-available-for-testnet')
    assert.equal(body.sourceVerificationStatus, 'unknown')
    assert.equal(body.officialMainnetUsdtAddressMatch, false)
  })
  assert.equal(calls, 0)
})

test('invalid network and malformed Base58Check address are rejected before scanner requests', async () => {
  let calls = 0
  await withServer({ fetchImpl: async () => { calls += 1; return explorerResponse(null) } }, async baseUrl => {
    const wrongNetwork = await fetch(`${baseUrl}/api/tron/token-authenticity?network=other&contract=${OFFICIAL_MAINNET_USDT_CONTRACT}`)
    const wrongAddress = await fetch(`${baseUrl}/api/tron/token-authenticity?network=mainnet&contract=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj5`)
    assert.equal(wrongNetwork.status, 400)
    assert.equal(wrongAddress.status, 400)
  })
  assert.equal(calls, 0)
})

test('scanner errors return unknown evidence, never an invented verification status', async () => {
  await withServer({ fetchImpl: async () => { throw new Error('sensitive provider error') } }, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/tron/token-authenticity?network=mainnet&contract=${OFFICIAL_MAINNET_USDT_CONTRACT}`)
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.explorerStatus, 'unavailable')
    assert.equal(body.sourceVerificationStatus, 'unknown')
    assert.equal(body.explorerRiskLevel, 'unknown')
    assert.doesNotMatch(JSON.stringify(body), /sensitive provider error/)
    assert.equal(body.officialMainnetUsdtAddressMatch, true)
  })
})
