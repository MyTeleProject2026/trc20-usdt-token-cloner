import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyTronDposSolidification } from '../server/tron-dpos-finality.mjs'

function witnessList({ heights = [], activeCount = 27, addressOffset = 0 } = {}) {
  return {
    witnesses: Array.from({ length: 27 }, (_, index) => ({
      address: '41' + (index + addressOffset + 1).toString(16).padStart(40, '0'),
      latestBlockNum: heights[index] ?? 200,
      isJobs: index < activeCount,
    })),
  }
}

test('recomputes the java-tron 70 percent active-SR solidification threshold', () => {
  const list = witnessList({ heights: Array(27).fill(500) })
  const result = verifyTronDposSolidification({
    primaryWitnessList: list,
    secondaryWitnessList: structuredClone(list),
    expectedBlockNumber: 400,
  })

  assert.equal(result.verified, true, JSON.stringify(result))
  assert.equal(result.solidifiedHeight, 500)
  assert.equal(result.activeWitnessCount, 27)
  assert.equal(result.requiredSupportingWitnessCount, 19)
  assert.equal(result.supportingWitnessCount, 27)
  assert.equal(result.thresholdPercent, 70)
})

test('uses the lower latestBlockNum from both providers for each active SR', () => {
  const primary = witnessList({ heights: Array(27).fill(500) })
  const secondary = witnessList({ heights: Array(27).fill(500) })
  primary.witnesses[0].latestBlockNum = 800
  secondary.witnesses[0].latestBlockNum = 100

  const result = verifyTronDposSolidification({
    primaryWitnessList: primary,
    secondaryWitnessList: secondary,
    expectedBlockNumber: 150,
  })

  assert.equal(result.verified, true)
  assert.equal(result.solidifiedHeight, 500)
  assert.equal(result.supportingWitnessCount, 26)
})

test('rejects a target above the recomputed 19-of-27 witness solidified height', () => {
  const heights = Array.from({ length: 27 }, (_, index) => index < 8 ? 100 : 200)
  const list = witnessList({ heights })
  const result = verifyTronDposSolidification({
    primaryWitnessList: list,
    secondaryWitnessList: structuredClone(list),
    expectedBlockNumber: 150,
  })

  assert.equal(result.verified, false)
  assert.equal(result.reason, 'target-block-not-solidified-by-active-witness-threshold')
  assert.equal(result.solidifiedHeight, 200)
  assert.equal(result.supportingWitnessCount, 19)
})

test('rejects a provider disagreement about the active witness set', () => {
  const primary = witnessList()
  const secondary = witnessList({ addressOffset: 1 })
  const result = verifyTronDposSolidification({
    primaryWitnessList: primary,
    secondaryWitnessList: secondary,
    expectedBlockNumber: 100,
  })
  assert.equal(result.verified, false)
  assert.equal(result.reason, 'solidified-active-witness-set-disagreement')
})

test('rejects malformed, duplicate, or incomplete active witness snapshots', () => {
  const malformed = witnessList()
  malformed.witnesses[0].address = 'Tbad'
  const invalid = verifyTronDposSolidification({
    primaryWitnessList: malformed,
    secondaryWitnessList: witnessList(),
    expectedBlockNumber: 100,
  })
  assert.equal(invalid.verified, false)
  assert.equal(invalid.reason, 'solidified-active-witness-record-invalid')

  const duplicate = witnessList()
  duplicate.witnesses[1].address = duplicate.witnesses[0].address
  const duplicateResult = verifyTronDposSolidification({
    primaryWitnessList: duplicate,
    secondaryWitnessList: witnessList(),
    expectedBlockNumber: 100,
  })
  assert.equal(duplicateResult.verified, false)
  assert.equal(duplicateResult.reason, 'solidified-active-witness-record-invalid')

  const incomplete = witnessList({ activeCount: 26 })
  const incompleteResult = verifyTronDposSolidification({
    primaryWitnessList: incomplete,
    secondaryWitnessList: witnessList(),
    expectedBlockNumber: 100,
  })
  assert.equal(incompleteResult.verified, false)
  assert.equal(incompleteResult.reason, 'solidified-active-witness-count-invalid')
})

test('rejects missing witness state and invalid target input', () => {
  const noState = verifyTronDposSolidification({
    primaryWitnessList: {},
    secondaryWitnessList: witnessList(),
    expectedBlockNumber: 100,
  })
  assert.equal(noState.verified, false)
  assert.equal(noState.reason, 'solidified-witness-list-unavailable')

  const badInput = verifyTronDposSolidification({
    primaryWitnessList: witnessList(),
    secondaryWitnessList: witnessList(),
    expectedBlockNumber: 0,
  })
  assert.equal(badInput.verified, false)
  assert.equal(badInput.reason, 'solidified-witness-proof-input-invalid')
})
