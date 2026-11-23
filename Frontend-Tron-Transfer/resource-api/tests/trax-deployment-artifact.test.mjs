import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { loadPinnedTRAXDeploymentArtifact } from '../trax-deployment-artifact.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'trax-artifact-'))
  const payload = {
    schemaVersion: 1, contractName: 'Restricted1TRAX', network: 'TRON Mainnet',
    compiler: 'solc 0.8.25', evmVersion: 'paris', optimizer: { enabled: true, runs: 1 },
    sourceSha256: '1'.repeat(64), abi: [], bytecode: '6000', deployedBytecode: '6001',
  }
  payload.creationBytecodeSha256 = sha(Buffer.from(payload.bytecode, 'hex'))
  payload.runtimeBytecodeSha256 = sha(Buffer.from(payload.deployedBytecode, 'hex'))
  const withoutHash = JSON.stringify(payload)
  payload.artifactSha256 = sha(withoutHash)
  const artifactPath = path.join(dir, 'artifact.json')
  await writeFile(artifactPath, JSON.stringify(payload))
  const env = {
    TRAX_SOURCE_SHA256: payload.sourceSha256,
    TRAX_CREATION_BYTECODE_SHA256: payload.creationBytecodeSha256,
    TRAX_RUNTIME_BYTECODE_SHA256: payload.runtimeBytecodeSha256,
    TRAX_DEPLOYMENT_ARTIFACT_SHA256: payload.artifactSha256,
  }
  return { dir, artifactPath, env, payload }
}
test('TRӾ artifact loader requires all explicit deployment pins', async () => {
  const f = await fixture()
  try {
    await assert.rejects(loadPinnedTRAXDeploymentArtifact({ env: {}, artifactPath: f.artifactPath }), /TRAX_SOURCE_SHA256_NOT_CONFIGURED/)
  } finally { await rm(f.dir, { recursive: true, force: true }) }
})
test('TRӾ artifact loader verifies source, creation, runtime and manifest hashes', async () => {
  const f = await fixture()
  try {
    const loaded = await loadPinnedTRAXDeploymentArtifact({ env: f.env, artifactPath: f.artifactPath })
    assert.equal(loaded.artifactSha256, f.payload.artifactSha256)
    assert.equal(loaded.creationBytecodeSha256, f.payload.creationBytecodeSha256)
    assert.equal(loaded.runtimeBytecodeSha256, f.payload.runtimeBytecodeSha256)
    await writeFile(f.artifactPath, JSON.stringify({ ...f.payload, bytecode: '6002' }))
    await assert.rejects(loadPinnedTRAXDeploymentArtifact({ env: f.env, artifactPath: f.artifactPath }), /TRAX_CREATION_BYTECODE_SHA256_MISMATCH/)
  } finally { await rm(f.dir, { recursive: true, force: true }) }
})
