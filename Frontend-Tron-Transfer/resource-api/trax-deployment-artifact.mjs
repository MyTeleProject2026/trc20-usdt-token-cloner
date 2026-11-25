import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const here = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ARTIFACT = path.join(here, 'generated', 'trax-deployment-artifact.json')
const hash = value => createHash('sha256').update(value).digest('hex')
const HASH = /^[0-9a-f]{64}$/

export async function loadPinnedTRAXDeploymentArtifact({
  env = process.env,
  artifactPath = DEFAULT_ARTIFACT,
} = {}) {
  const requiredPins = {
    TRAX_SOURCE_SHA256: env.TRAX_SOURCE_SHA256,
    TRAX_CREATION_BYTECODE_SHA256: env.TRAX_CREATION_BYTECODE_SHA256,
    TRAX_RUNTIME_BYTECODE_SHA256: env.TRAX_RUNTIME_BYTECODE_SHA256,
    TRAX_DEPLOYMENT_ARTIFACT_SHA256: env.TRAX_DEPLOYMENT_ARTIFACT_SHA256,
  }
  for (const [name, value] of Object.entries(requiredPins)) {
    if (typeof value !== 'string' || !HASH.test(value)) {
      throw Object.assign(new Error(name + '_NOT_CONFIGURED'), { code: name + '_NOT_CONFIGURED', status: 503 })
    }
  }
  let artifact
  try { artifact = JSON.parse(await fs.readFile(artifactPath, 'utf8')) } catch {
    throw Object.assign(new Error('TRAX_DEPLOYMENT_ARTIFACT_NOT_BUILT'), { code: 'TRAX_DEPLOYMENT_ARTIFACT_NOT_BUILT', status: 503 })
  }
  if (artifact?.schemaVersion !== 1 || artifact?.contractName !== 'Restricted1TRAX'
    || artifact?.network !== 'TRON Mainnet' || artifact?.compiler !== 'solc 0.8.25'
    || artifact?.evmVersion !== 'paris' || artifact?.optimizer?.enabled !== true
    || artifact?.optimizer?.runs !== 1 || !Array.isArray(artifact?.abi)
    || !/^(?:[0-9a-f]{2})+$/i.test(String(artifact?.bytecode || ''))
    || !/^(?:[0-9a-f]{2})+$/i.test(String(artifact?.deployedBytecode || ''))) {
    throw Object.assign(new Error('TRAX_DEPLOYMENT_ARTIFACT_INVALID'), { code: 'TRAX_DEPLOYMENT_ARTIFACT_INVALID', status: 503 })
  }
  const actual = {
    TRAX_SOURCE_SHA256: artifact.sourceSha256,
    TRAX_CREATION_BYTECODE_SHA256: hash(Buffer.from(artifact.bytecode, 'hex')),
    TRAX_RUNTIME_BYTECODE_SHA256: hash(Buffer.from(artifact.deployedBytecode, 'hex')),
  }
  const artifactWithoutHash = { ...artifact }
  delete artifactWithoutHash.artifactSha256
  actual.TRAX_DEPLOYMENT_ARTIFACT_SHA256 = hash(JSON.stringify(artifactWithoutHash))
  for (const [name, value] of Object.entries(actual)) {
    if (value !== requiredPins[name]) {
      throw Object.assign(new Error(name + '_MISMATCH'), { code: name + '_MISMATCH', status: 503 })
    }
  }
  if (artifact.creationBytecodeSha256 !== actual.TRAX_CREATION_BYTECODE_SHA256
    || artifact.runtimeBytecodeSha256 !== actual.TRAX_RUNTIME_BYTECODE_SHA256
    || artifact.artifactSha256 !== actual.TRAX_DEPLOYMENT_ARTIFACT_SHA256) {
    throw Object.assign(new Error('TRAX_DEPLOYMENT_ARTIFACT_FINGERPRINT_INVALID'), { code: 'TRAX_DEPLOYMENT_ARTIFACT_FINGERPRINT_INVALID', status: 503 })
  }
  return Object.freeze({
    contractName: artifact.contractName,
    network: artifact.network,
    compiler: artifact.compiler,
    sourceSha256: actual.TRAX_SOURCE_SHA256,
    creationBytecodeSha256: actual.TRAX_CREATION_BYTECODE_SHA256,
    runtimeBytecodeSha256: actual.TRAX_RUNTIME_BYTECODE_SHA256,
    artifactSha256: actual.TRAX_DEPLOYMENT_ARTIFACT_SHA256,
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    deployedBytecode: artifact.deployedBytecode,
  })
}
