import test from 'node:test'
import assert from 'node:assert/strict'
import { validateMainnetResourceSnapshot } from '../src/mainnet-resource-validation.mjs'

const owner = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const now = Date.parse('2026-11-19T12:00:00.000Z')
const valid = {
  address: owner,
  network: 'TRON Mainnet',
  checkedAt: new Date(now - 5_000).toISOString(),
  energy: { available: '120000', limit: '150000', used: '30000' },
  bandwidth: {
    freeAvailable: '300',
    stakedOrDelegatedAvailable: '900',
    maxSingleTransactionAvailable: '900',
  },
  balanceSun: '70000',
  rpc: { providersUsed: { accountResources: 'tatum', account: 'trongrid', chainParameters: 'tatum' } },
}

test('accepts a fresh Mainnet snapshot for the exact configured owner', () => {
  assert.equal(validateMainnetResourceSnapshot(valid, owner, now).state, 'online')
})

test('reports owner and network mismatches explicitly', () => {
  assert.match(validateMainnetResourceSnapshot({ ...valid, address: 'TWrong' }, owner, now).detail, /owner mismatch/)
  assert.match(validateMainnetResourceSnapshot({ ...valid, network: 'TRON Nile Testnet' }, owner, now).detail, /network mismatch/)
})

test('reports the exact malformed resource field', () => {
  const result = validateMainnetResourceSnapshot({ ...valid, bandwidth: { ...valid.bandwidth, freeAvailable: null } }, owner, now)
  assert.match(result.detail, /bandwidth.freeAvailable/)
})

test('rejects missing provider attribution and stale snapshots', () => {
  assert.match(validateMainnetResourceSnapshot({ ...valid, rpc: { providersUsed: {} } }, owner, now).detail, /rpc.providersUsed/)
  const stale = { ...valid, checkedAt: new Date(now - 60_000).toISOString() }
  assert.match(validateMainnetResourceSnapshot(stale, owner, now).detail, /stale/)
})

test('does not treat resource telemetry validation as deployment authorization', () => {
  const result = validateMainnetResourceSnapshot(valid, owner, now)
  assert.equal(result.deploymentAuthorized, undefined)
  assert.equal(result.state, 'online')
})
