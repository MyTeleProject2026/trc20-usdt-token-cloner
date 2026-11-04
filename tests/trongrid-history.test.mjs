import test from 'node:test'
import assert from 'node:assert/strict'
import {
  readTronGridIncomingHistory,
  normalizeTronGridNativeIncoming,
  normalizeTronGridTrc20Incoming,
  TRONGRID_HISTORY_ORIGINS,
} from '../server/trongrid-history.mjs'

const recipient = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'
const sender = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'
const contract = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const txNative = 'a'.repeat(64)
const txToken = 'b'.repeat(64)
const decodeAddress = (hex) => {
  const normalized = String(hex).replace(/^41/i, '').toLowerCase()
  if (normalized === '11'.repeat(20)) return sender
  if (normalized === '22'.repeat(20)) return recipient
  if (normalized === '33'.repeat(20)) return contract
  throw new Error('unexpected test address')
}

test('TRON network history adapter uses the correct network-specific origins', () => {
  assert.equal(TRONGRID_HISTORY_ORIGINS.nile, 'https://nile.trongrid.io')
  assert.equal(TRONGRID_HISTORY_ORIGINS.shasta, 'https://api.shasta.trongrid.io')
  assert.equal(TRONGRID_HISTORY_ORIGINS.mainnet, 'https://api.trongrid.io')
})

test('native incoming history normalizes only confirmed TRX transfers to the requested account', () => {
  const payload = { data: [
    {
      txID: txNative,
      block_timestamp: 1730000000000,
      blockNumber: 123,
      raw_data: { contract: [{ type: 'TransferContract', parameter: { value: {
        owner_address: '41' + '11'.repeat(20),
        to_address: '41' + '22'.repeat(20),
        amount: 2500000,
      } } }] },
    },
    {
      txID: 'c'.repeat(64),
      raw_data: { contract: [{ type: 'TransferContract', parameter: { value: {
        owner_address: '41' + '11'.repeat(20),
        to_address: '41' + '33'.repeat(20),
        amount: 1000,
      } } }] },
    },
  ] }
  const rows = normalizeTronGridNativeIncoming(payload, recipient, decodeAddress)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].txid, txNative)
  assert.equal(rows[0].from, sender)
  assert.equal(rows[0].to, recipient)
  assert.equal(rows[0].amountBaseUnits, '2500000')
  assert.equal(rows[0].asset, 'TRX')
  assert.equal(rows[0].confirmed, true)
})

test('TRC20 incoming history normalizes exact token contract, amount and recipient', () => {
  const payload = { data: [{
    transaction_id: txToken,
    block_timestamp: 1730000000000,
    block_number: 456,
    from: sender,
    to: recipient,
    value: '1234500',
    token_info: { address: contract, symbol: 'USDT', decimals: 6 },
  }] }
  const rows = normalizeTronGridTrc20Incoming(payload, recipient, decodeAddress, contract)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].txid, txToken)
  assert.equal(rows[0].tokenContract, contract)
  assert.equal(rows[0].amountBaseUnits, '1234500')
  assert.equal(rows[0].decimals, 6)
  assert.equal(rows[0].confirmed, true)
})

test('recipient history requests confirmed incoming native and TRC20 data from the selected testnet', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url)
    calls.push({ parsed, init })
    const isToken = parsed.pathname.endsWith('/trc20')
    const data = isToken ? [{
      transaction_id: txToken, block_timestamp: 1730000000000, from: sender, to: recipient,
      value: '1234500', token_info: { address: contract, symbol: 'tUSDT', decimals: 6 },
    }] : [{
      txID: txNative, block_timestamp: 1730000000000,
      raw_data: { contract: [{ type: 'TransferContract', parameter: { value: {
        owner_address: '41' + '11'.repeat(20), to_address: '41' + '22'.repeat(20), amount: 2500000,
      } } }] },
    }]
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const result = await readTronGridIncomingHistory({
    network: 'nile', address: recipient, tokenContract: contract,
    apiKey: 'server-only-test-key', fetchImpl, decodeAddress,
  })
  assert.equal(result.historyStatus, 'complete')
  assert.equal(result.nativeHistoryRead, true)
  assert.equal(result.tokenHistoryRead, true)
  assert.deepEqual(result.history.map((row) => row.txid).sort(), [txNative, txToken].sort())
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.equal(call.parsed.origin, 'https://nile.trongrid.io')
    assert.equal(call.parsed.searchParams.get('only_confirmed'), 'true')
    assert.equal(call.parsed.searchParams.get('only_to'), 'true')
    assert.equal(call.parsed.searchParams.get('limit'), '50')
    assert.equal(call.init.headers['TRON-PRO-API-KEY'], 'server-only-test-key')
  }
  assert.ok(calls.some((call) => call.parsed.pathname.endsWith('/transactions/trc20')
    && call.parsed.searchParams.get('contract_address') === contract))
})

test('recipient history still queries TRC20 when no contract filter is supplied', async () => {
  const paths = []
  const fetchImpl = async (url) => {
    const parsed = new URL(url)
    paths.push(parsed.pathname)
    return new Response(JSON.stringify({ data: [] }), { status: 200 })
  }
  const result = await readTronGridIncomingHistory({
    network: 'nile', address: recipient, fetchImpl, decodeAddress,
  })
  assert.equal(result.historyStatus, 'complete')
  assert.ok(paths.includes('/v1/accounts/' + recipient + '/transactions'))
  assert.ok(paths.includes('/v1/accounts/' + recipient + '/transactions/trc20'))
})

test('recipient history reports partial provider failure without fabricating a complete result', async () => {
  const fetchImpl = async (url) => {
    const parsed = new URL(url)
    if (parsed.pathname.endsWith('/trc20')) return new Response('{}', { status: 503 })
    return new Response(JSON.stringify({ data: [] }), { status: 200 })
  }
  const result = await readTronGridIncomingHistory({
    network: 'shasta', address: recipient, fetchImpl, decodeAddress,
  })
  assert.equal(result.historyStatus, 'partial')
  assert.equal(result.nativeHistoryRead, true)
  assert.equal(result.tokenHistoryRead, false)
  assert.equal(result.providerErrors.trc20, 'http-503')
})

test('history adapter rejects unsupported networks and malformed recipient addresses', async () => {
  await assert.rejects(
    readTronGridIncomingHistory({ network: 'unknown', address: recipient }),
    /Unsupported TRON history network/,
  )
  await assert.rejects(
    readTronGridIncomingHistory({ network: 'nile', address: 'not-a-tron-address' }),
    /Recipient must be a TRON Base58 address/,
  )
})
