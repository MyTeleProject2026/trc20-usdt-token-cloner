import fs from 'node:fs/promises'
import path from 'node:path'
import solc from 'solc'

const root = process.cwd()
const source = await fs.readFile(path.join(root, 'contracts/IndependentTRC20.sol'), 'utf8')
const input = {
  language: 'Solidity',
  sources: { 'IndependentTRC20.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
}
const output = JSON.parse(solc.compile(JSON.stringify(input)))
const errors = (output.errors || []).filter((entry) => entry.severity === 'error')
if (errors.length) {
  for (const error of errors) process.stderr.write(error.formattedMessage + '\n')
  process.exit(1)
}
const contract = output.contracts?.['IndependentTRC20.sol']?.IndependentTRC20
if (!contract?.evm?.bytecode?.object || !contract.abi) throw new Error('Solidity compiler did not produce ABI and bytecode')
const outDir = path.join(root, 'src/generated')
await fs.mkdir(outDir, { recursive: true })
const artifact = { abi: contract.abi, bytecode: contract.evm.bytecode.object }
const moduleText = 'export const tokenArtifact = ' + JSON.stringify(artifact) + ' as const\n'
await fs.writeFile(path.join(outDir, 'IndependentTRC20.ts'), moduleText)
console.log('Compiled IndependentTRC20.sol for browser-side wallet deployment.')
