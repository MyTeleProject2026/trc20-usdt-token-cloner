import fs from 'node:fs/promises'
import path from 'node:path'
import solc from 'solc'
const root = process.cwd()
const files = [
  ['IndependentTRC20.sol', 'IndependentTRC20'],
  ['Restricted1TRAX.sol', 'Restricted1TRAX'],
  ['OneTraxReserveVault.sol', 'OneTraxReserveVault'],
]
const sources = {}
for (const [file] of files) sources[file] = { content: await fs.readFile(path.join(root, 'contracts', file), 'utf8') }
const input = { language: 'Solidity', sources, settings: { evmVersion: 'paris', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } }
const output = JSON.parse(solc.compile(JSON.stringify(input)))
const errors = (output.errors || []).filter((entry) => entry.severity === 'error')
if (errors.length) { for (const error of errors) process.stderr.write(error.formattedMessage + '\n'); process.exit(1) }
const outDir = path.join(root, 'src/generated')
await fs.mkdir(outDir, { recursive: true })
for (const [file, contractName] of files) {
  const contract = output.contracts?.[file]?.[contractName]
  if (!contract?.evm?.bytecode?.object || !contract.abi) throw new Error('Compiler output missing for ' + contractName)
  const artifact = { contractName, abi: contract.abi, bytecode: contract.evm.bytecode.object }
  await fs.writeFile(path.join(outDir, contractName + '.ts'), 'export const tokenArtifact = ' + JSON.stringify(artifact) + ' as const\n')
}
console.log('Compiled IndependentTRC20, Restricted1TRAX and OneTraxReserveVault contracts for the Paris EVM target.')
