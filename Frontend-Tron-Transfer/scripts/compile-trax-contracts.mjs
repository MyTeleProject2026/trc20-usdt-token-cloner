import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import solc from 'solc'

const here = path.dirname(fileURLToPath(import.meta.url))
const frontendRoot = path.resolve(here, '..')
const repositoryRoot = path.resolve(frontendRoot, '..')
const tokenPath = path.join(repositoryRoot, 'contracts', 'Restricted1TRAX.sol')
const tokenSource = await fs.readFile(tokenPath, 'utf8')

const compilerVersion = solc.version().split('+')[0]
if (compilerVersion !== '0.8.25') {
  throw new Error('Expected pinned Solidity compiler 0.8.25, but found ' + compilerVersion + '.')
}

const input = {
  language: 'Solidity',
  sources: {
    'Restricted1TRAX.sol': { content: tokenSource },
  },
  settings: {
    evmVersion: 'paris',
    optimizer: { enabled: true, runs: 1 },
    outputSelection: {
      '*': {
        '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'],
      },
    },
  },
}

const output = JSON.parse(solc.compile(JSON.stringify(input)))
const diagnostics = output.errors || []
for (const diagnostic of diagnostics) {
  const message = (diagnostic.formattedMessage || diagnostic.message || '').trim()
  if (diagnostic.severity === 'error') console.error(message)
  else if (message) console.warn(message)
}
const errors = diagnostics.filter(item => item.severity === 'error')
if (errors.length) {
  throw new Error('TRӾ Solidity compilation failed with ' + errors.length + ' error(s). No deployment should be attempted.')
}

const compiled = output.contracts?.['Restricted1TRAX.sol']?.Restricted1TRAX
const bytecode = compiled?.evm?.bytecode?.object || ''
if (!compiled || !Array.isArray(compiled.abi) || !/^(?:[0-9a-f]{2})+$/i.test(bytecode)) {
  throw new Error('Solidity compiler did not produce a valid TRӾ ABI and init bytecode.')
}

const artifact = {
  compiler: 'TRON solc ' + compilerVersion,
  evmVersion: 'paris',
  optimizer: { enabled: true, runs: 1 },
  token: {
    contractName: 'Restricted1TRAX',
    abi: compiled.abi,
    bytecode,
    deployedBytecode: compiled.evm.deployedBytecode.object,
  },
}

const outputDir = path.join(frontendRoot, 'src', 'generated')
await fs.mkdir(outputDir, { recursive: true })
await fs.writeFile(
  path.join(outputDir, 'trax-contract-artifacts.js'),
  'export default ' + JSON.stringify(artifact) + ';' + String.fromCharCode(10),
)
console.log('Owner-issued TRӾ compiled with Solidity ' + compilerVersion + ' (Paris EVM, optimizer 1). Init bytecode: ' + (bytecode.length / 2) + ' bytes; runtime bytecode: ' + (compiled.evm.deployedBytecode.object.length / 2) + ' bytes.')
