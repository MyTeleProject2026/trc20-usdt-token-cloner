import test from 'node:test'
import assert from 'node:assert/strict'
import { readSponsorDelegationSnapshot } from '../server/sponsor-delegation-snapshot.mjs'

const feeSponsor = 'T' + 'A'.repeat(33)
const principalSponsor = 'T' + 'C'.repeat(33)
const otherSponsor = 'T' + 'B'.repeat(33)
const feeHex = '41' + 'a'.repeat(40)
const principalHex = '41' + 'c'.repeat(40)
const otherHex = '41' + 'b'.repeat(40)

function fakeTronWeb() {
  const addresses = new Map([
    [feeSponsor, feeHex],
    [principalSponsor, principalHex],
    [otherSponsor, otherHex],
  ])
  return {
    isAddress(value) { return addresses.has(value) },
    address: { toHex(value) { return addresses.get(value) || '' } },
  }
}

function baseInput(overrides = {}) {
  return {
    env: {
      TATUM_API_KEY: 'server-only-test-key',
      SPONSOR_FEE_NILE_ADDRESS: feeSponsor,
      SPONSOR_ASSET_NILE_ADDRESS: principalSponsor,
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({ delegatedResource: [] }) }),
    network: 'nile',
    tronWeb: fakeTronWeb(),
    ...overrides,
  }
}

test('does not query provider when sponsor roles or Tatum credentials are missing', async (t) => {
  await t.test('missing role addresses', async () => {
    let calls = 0
    const result = await readSponsorDelegationSnapshot({
      env: {},
      network: 'nile',
      tronWeb: fakeTronWeb(),
      fetchImpl: async () => { calls += 1; throw new Error('must not call') },
    })
    assert.equal(result.success, false)
    assert.equal(result.status, 'sponsor-role-addresses-not-configured')
    assert.equal(calls, 0)
  })
  await t.test('missing API key', async () => {
    let calls = 0
    const result = await readSponsorDelegationSnapshot({
      env: {
        SPONSOR_FEE_NILE_ADDRESS: feeSponsor,
        SPONSOR_ASSET_NILE_ADDRESS: principalSponsor,
      },
      network: 'nile',
      tronWeb: fakeTronWeb(),
      fetchImpl: async () => { calls += 1; throw new Error('must not call') },
    })
    assert.equal(result.success, false)
    assert.equal(result.status, 'provider-credentials-missing')
    assert.deepEqual(result.requiredEnvironment, ['TATUM_API_KEY'])
    assert.equal(calls, 0)
  })
})

test('reads exact current solidified delegation from the fee sponsor to the principal sponsor', async () => {
  const expires = Date.now() + 60_000
  const requests = []
  const result = await readSponsorDelegationSnapshot(baseInput({
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return {
        ok: true,
        json: async () => ({
          delegatedResource: [
            {
              from: feeHex,
              to: principalHex,
              frozen_balance_for_energy: '9000000',
              frozen_balance_for_bandwidth: '3000000',
              expire_time_for_energy: 0,
              expire_time_for_bandwidth: expires,
            },
            {
              from: otherHex,
              to: principalHex,
              frozen_balance_for_energy: '99999999',
              frozen_balance_for_bandwidth: '99999999',
              expire_time_for_energy: 0,
              expire_time_for_bandwidth: 0,
            },
          ],
        }),
      }
    },
  }))
  assert.equal(result.success, true)
  assert.equal(result.status, 'solidified-delegation-state-read')
  assert.equal(result.fromAddress, feeSponsor)
  assert.equal(result.toAddress, principalSponsor)
  assert.equal(result.activeEnergyStakeSun, '9000000')
  assert.equal(result.activeBandwidthStakeSun, '3000000')
  assert.equal(result.activeBandwidthExpiry, expires)
  assert.equal(result.matchingDelegationRows, 1)
  assert.equal(result.transactionAuditVerified, false)
  assert.equal(JSON.stringify(result).includes('server-only-test-key'), false)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://tron-nile.gateway.tatum.io/walletsolidity/getdelegatedresourcev2')
  assert.equal(requests[0].options.headers['x-api-key'], 'server-only-test-key')
  const body = JSON.parse(requests[0].options.body)
  assert.equal(body.fromAddress, feeHex)
  assert.equal(body.toAddress, principalHex)
})

test('expired delegated resources are not counted as active resource allocation', async () => {
  const expired = Date.now() - 60_000
  const result = await readSponsorDelegationSnapshot(baseInput({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        delegatedResource: [{
          from: feeHex,
          to: principalHex,
          frozen_balance_for_energy: '5000000',
          frozen_balance_for_bandwidth: '7000000',
          expire_time_for_energy: expired,
          expire_time_for_bandwidth: 0,
        }],
      }),
    }),
  }))
  assert.equal(result.success, true)
  assert.equal(result.status, 'solidified-delegation-state-read')
  assert.equal(result.activeEnergyStakeSun, '0')
  assert.equal(result.activeBandwidthStakeSun, '7000000')
})

test('distinguishes no delegation from provider failure', async () => {
  const empty = await readSponsorDelegationSnapshot(baseInput())
  assert.equal(empty.success, true)
  assert.equal(empty.status, 'solidified-no-delegation-observed')
  assert.equal(empty.activeEnergyStakeSun, '0')
  assert.equal(empty.activeBandwidthStakeSun, '0')

  const unavailable = await readSponsorDelegationSnapshot(baseInput({
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  }))
  assert.equal(unavailable.success, false)
  assert.equal(unavailable.status, 'solidified-delegation-read-unavailable')
  assert.equal(unavailable.providerStatus, 503)
})

test('rejects malformed resource quantities instead of treating them as a funded delegation', async () => {
  const result = await readSponsorDelegationSnapshot(baseInput({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        delegatedResource: [{
          from: feeHex,
          to: principalHex,
          frozen_balance_for_energy: 'NaN',
          frozen_balance_for_bandwidth: '1000000',
        }],
      }),
    }),
  }))
  assert.equal(result.success, false)
  assert.equal(result.status, 'solidified-delegation-read-unavailable')
  assert.equal(result.activeEnergyStakeSun, null)
})
