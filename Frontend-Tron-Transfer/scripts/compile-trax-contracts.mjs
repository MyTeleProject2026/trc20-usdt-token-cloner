import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import solc from 'solc'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const contracts = {
  'Restricted1TRAX.sol': await fs.readFile(path.join(root, 'contracts/Restricted1TRAX.sol'), 'utf8'),
  'OneTraxReserveVault.sol': await fs.readFile(path.join(root, 'contracts/OneTraxReserveVault.sol'), 'utf8'),
}
const input = {
  language: 'Solidity',
  sources: Object.fromEntries(Object.entries(contracts).map(([name, content]) => [name, { content }])),
  settings: {
    evmVersion: 'paris',
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
}
const output = JSON.parse(solc.compile(JSON.stringify(input)))
const errors = (output.errors || []).filter((entry) => entry.severity === 'error')
if (errors.length) throw new Error(errors.map((entry) => entry.formattedMessage).join('\n'))

const token = output.contracts?.['Restricted1TRAX.sol']?.Restricted1TRAX
const vault = output.contracts?.['OneTraxReserveVault.sol']?.OneTraxReserveVault
if (!token?.abi || !token.evm?.bytecode?.object || !vault?.abi || !vault.evm?.bytecode?.object) {
  throw new Error('TRӾ artifacts are incomplete; refusing to build the Mainnet interface.')
}
const artifact = {
  compiler: solc.version(),
  evmVersion: 'paris',
  optimizer: { enabled: true, runs: 200 },
  token: { contractName: 'Restricted1TRAX', abi: token.abi, bytecode: token.evm.bytecode.object },
  vault: { contractName: 'OneTraxReserveVault', abi: vault.abi, bytecode: vault.evm.bytecode.object },
}
const outputDir = path.join(here, '../src/generated')
await fs.mkdir(outputDir, { recursive: true })
await fs.writeFile(path.join(outputDir, 'trax-contract-artifacts.json'), JSON.stringify(artifact))
console.log('Compiled TRӾ token and native TRX reserve vault artifacts for TRON TVM (Paris EVM target).')
