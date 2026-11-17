import test from 'node:test'
import assert from 'node:assert/strict'
import { createTRAXVerificationBundle } from '../scripts/export-trax-verification-bundle.mjs'

const source = 'pragma solidity ^0.8.25; contract Restricted1TRAX { constructor() {} }'

test('TRӾ verification bundle preserves the exact Mainnet compiler settings', () => {
  const bundle = createTRAXVerificationBundle(source, '0.8.25+commit.b61c2a91.Emscripten.clang')
  assert.equal(bundle.contractName, 'Restricted1TRAX')
  assert.equal(bundle.network, 'TRON Mainnet')
  assert.equal(bundle.evmVersion, 'paris')
  assert.deepEqual(bundle.optimizer, { enabled: true, runs: 1 })
  assert.equal(bundle.standardJsonInput.sources['Restricted1TRAX.sol'].content, source)
  assert.equal(bundle.standardJsonInput.settings.evmVersion, 'paris')
  assert.deepEqual(bundle.standardJsonInput.settings.optimizer, { enabled: true, runs: 1 })
  assert.ok(bundle.compilerMetadata)
  assert.match(bundle.runtimeBytecodeSha256, /^[0-9a-f]{64}$/)
})

test('TRӾ verification bundle never invents a deployed address or claims submission', () => {
  const bundle = createTRAXVerificationBundle(source, '0.8.25+commit.b61c2a91.Emscripten.clang')
  assert.equal(bundle.contractAddress, null)
  assert.equal(bundle.constructorArguments, '')
  assert.equal(bundle.verificationStatus, 'not-submitted-no-deployed-address')
  assert.ok(bundle.instructions.some(item => item.includes('does not submit verification')))
})

test('TRӾ verification bundle rejects an unpinned compiler or missing source', () => {
  assert.throws(() => createTRAXVerificationBundle(source, '0.8.26+commit.abc'), /pinned Solidity compiler 0.8.25/)
  assert.throws(() => createTRAXVerificationBundle('', '0.8.25+commit.b61c2a91'), /source is required/)
})
