import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import solc from 'solc'

const here = path.dirname(fileURLToPath(import.meta.url))
const frontendRoot = path.resolve(here, '..')
const repositoryRoot = path.resolve(frontendRoot, '..')
const tokenPath = path.join(repositoryRoot, 'contracts', 'Restricted1TRAX.sol')
const vaultPath = path.join(repositoryRoot, 'contracts', 'OneTraxReserveVault.sol')

const [tokenSource, vaultSource] = await Promise.all([
  fs.readFile(tokenPath, 'utf8'),
  fs.readFile(vaultPath, 'utf8'),
])

const input = {
  language: 'Solidity',
  sources: {
    'Restricted1TRAX.sol': { content: tokenSource },
    'OneTraxReserveVault.sol': { content: vaultSource },
  },
  settings: {
    optimizer: { enabled: true, runs: 200 },
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
  const render = (diagnostic.formattedMessage || diagnostic.message || '').trim()
  if (diagnostic.severity === 'error') console.error(render)
  else if (render) console.warn(render)
}
const fatalErrors = diagnostics.filter(item => item.severity === 'error')
if (fatalErrors.length) {
  throw new Error('TRӾ Solidity compilation failed with ' + fatalErrors.length + ' error(s). No deployment should be attempted.')
}

function artifact(sourceName, contractName) {
  const compiled = output.contracts?.[sourceName]?.[contractName]
  const bytecode = compiled?.evm?.bytecode?.object || ''
  if (!compiled || !Array.isArray(compiled.abi) || !/^(?:[0-9a-f]{2})+$/i.test(bytecode)) {
    throw new Error('Solidity compiler did not produce a valid ABI and init bytecode for ' + contractName)
  }
  return { contractName, abi: compiled.abi, bytecode }
}

const token = artifact('Restricted1TRAX.sol', 'Restricted1TRAX')
const vault = artifact('OneTraxReserveVault.sol', 'OneTraxReserveVault')
const compilerVersion = solc.version().split('+')[0]
if (compilerVersion !== '0.8.25') {
  throw new Error('Expected Solidity compiler 0.8.25 but found ' + compilerVersion + '.')
}

const outputDir = path.join(frontendRoot, 'src', 'generated')
await fs.mkdir(outputDir, { recursive: true })
const compiledArtifacts = {
  compiler: 'TRON solc ' + compilerVersion,
  optimizer: { enabled: true, runs: 200 },
  token,
  vault,
}
await fs.writeFile(
  path.join(outputDir, 'trax-contract-artifacts.js'),
  'export default ' + JSON.stringify(compiledArtifacts) + ';\n',
)
console.log('TRӾ and native TRX reserve vault compiled with Solidity ' + compilerVersion + '.')
