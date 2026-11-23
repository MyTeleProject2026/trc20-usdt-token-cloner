import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import solc from 'solc'

const here = path.dirname(fileURLToPath(import.meta.url))
const apiRoot = path.resolve(here, '..')
const repositoryRoot = path.resolve(apiRoot, '..', '..')
const sourcePath = path.join(repositoryRoot, 'contracts', 'Restricted1TRAX.sol')
const source = await fs.readFile(sourcePath, 'utf8')
const compilerVersion = solc.version().split('+')[0]
if (compilerVersion !== '0.8.25') throw new Error('TRӾ deployment artifact requires pinned solc 0.8.25.')

const input = {
  language: 'Solidity',
  sources: { 'Restricted1TRAX.sol': { content: source } },
  settings: {
    evmVersion: 'paris',
    optimizer: { enabled: true, runs: 1 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
}
const output = JSON.parse(solc.compile(JSON.stringify(input)))
const diagnostics = output.errors || []
for (const item of diagnostics) {
  const message = String(item.formattedMessage || item.message || '').trim()
  if (item.severity === 'error') console.error(message)
  else if (message) console.warn(message)
}
if (diagnostics.some(item => item.severity === 'error')) throw new Error('TRӾ deployment artifact compilation failed.')
const contract = output.contracts?.['Restricted1TRAX.sol']?.Restricted1TRAX
const bytecode = contract?.evm?.bytecode?.object || ''
const deployedBytecode = contract?.evm?.deployedBytecode?.object || ''
if (!contract || !Array.isArray(contract.abi) || !/^(?:[0-9a-f]{2})+$/i.test(bytecode)
  || !/^(?:[0-9a-f]{2})+$/i.test(deployedBytecode)) {
  throw new Error('Compiler did not produce complete TRӾ creation and runtime bytecode.')
}
const sha256 = value => createHash('sha256').update(value).digest('hex')
const payload = {
  schemaVersion: 1,
  contractName: 'Restricted1TRAX',
  network: 'TRON Mainnet',
  compiler: 'solc ' + compilerVersion,
  evmVersion: 'paris',
  optimizer: { enabled: true, runs: 1 },
  sourceSha256: sha256(source),
  creationBytecodeSha256: sha256(Buffer.from(bytecode, 'hex')),
  runtimeBytecodeSha256: sha256(Buffer.from(deployedBytecode, 'hex')),
  abi: contract.abi,
  bytecode,
  deployedBytecode,
}
payload.artifactSha256 = sha256(JSON.stringify(payload))
const outputDir = path.join(apiRoot, 'generated')
await fs.mkdir(outputDir, { recursive: true })
await fs.writeFile(path.join(outputDir, 'trax-deployment-artifact.json'), JSON.stringify(payload) + '\n', { mode: 0o600 })
console.log(JSON.stringify({
  contractName: payload.contractName,
  compiler: payload.compiler,
  sourceSha256: payload.sourceSha256,
  creationBytecodeSha256: payload.creationBytecodeSha256,
  runtimeBytecodeSha256: payload.runtimeBytecodeSha256,
  artifactSha256: payload.artifactSha256,
}))
