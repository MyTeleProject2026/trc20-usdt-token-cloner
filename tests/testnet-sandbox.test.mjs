import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestnetPreview, parseSandboxUnits } from '../src/testnet-sandbox.mjs'

const from = 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL'
const to = 'THPvaUhoh2Qn2y9THCZML3H815hhFhn5YC'
const contract = 'T' + '3'.repeat(33)

test('creates a Nile TRX preview without a transaction identifier or network activity', () => {
  const preview = createTestnetPreview({
    network: 'nile',
    asset: 'TRX',
    from,
    to,
    amount: '1.25',
  }, 1_800_000_000_000)

  assert.equal(preview.network, 'nile')
  assert.equal(preview.amountBaseUnits, '1250000')
  assert.equal(preview.symbol, 'TRX')
  assert.equal(preview.status, 'preview-only')
  assert.equal(preview.signatureRequested, false)
  assert.equal(preview.broadcasted, false)
  assert.equal(preview.networkRequestMade, false)
  assert.equal(preview.transactionId, null)
})

test('creates a Shasta TRC-20 test-token preview with explicit contract and decimals', () => {
  const preview = createTestnetPreview({
    network: 'shasta',
    asset: 'TRC20',
    from,
    to,
    tokenContract: contract,
    symbol: 'DEMO',
    decimals: 4,
    amount: '12.3401',
  })

  assert.equal(preview.amountBaseUnits, '123401')
  assert.equal(preview.tokenContract, contract)
  assert.equal(preview.symbol, 'DEMO')
  assert.equal(preview.decimals, 4)
  assert.equal(preview.broadcasted, false)
})

test('rejects Mainnet and unknown networks', () => {
  for (const network of ['mainnet', 'sidechain', '', null]) {
    assert.throws(() => createTestnetPreview({
      network, asset: 'TRX', from, to, amount: '1',
    }), /Only Nile or Shasta/)
  }
})

test('rejects malformed and identical addresses', () => {
  assert.throws(() => createTestnetPreview({
    network: 'nile', asset: 'TRX', from: 'not-an-address', to, amount: '1',
  }), /Sender must be/)
  assert.throws(() => createTestnetPreview({
    network: 'nile', asset: 'TRX', from, to: from, amount: '1',
  }), /must be different/)
})

test('requires a test token contract and rejects the official Mainnet USDT identity', () => {
  assert.throws(() => createTestnetPreview({
    network: 'nile', asset: 'TRC20', from, to, symbol: 'DEMO', decimals: 6, amount: '1',
  }), /Test token contract/)
  assert.throws(() => createTestnetPreview({
    network: 'nile', asset: 'TRC20', from, to,
    tokenContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    symbol: 'USDT', decimals: 6, amount: '1',
  }), /official Mainnet USDT contract/)
})

test('enforces exact decimal precision and positive uint256 amounts', () => {
  assert.equal(parseSandboxUnits('0.000001', 6), '1')
  assert.throws(() => parseSandboxUnits('1.0000001', 6), /at most 6 decimal places/)
  assert.throws(() => parseSandboxUnits('0', 6), /greater than zero/)
  assert.throws(() => parseSandboxUnits('1e3', 6), /positive decimal/)
})
