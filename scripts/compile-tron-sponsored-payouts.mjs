import fs from 'node:fs/promises'
import path from 'node:path'
import solc from 'solc'

const root = process.cwd()
const contractPaths = [
  'contracts/MetaTxContext.sol',
  'contracts/TronMetaTxForwarder.sol',
  'contracts/Restricted1TRAXMeta.sol',
  'contracts/OneTraxReserveVaultMeta.sol',
  'contracts/NativeTRXPayoutTreasury.sol',
  'contracts/TronTransferPayoutRouter.sol',
]
const sources = {}
for (const file of contractPaths) {
  sources[file] = { content: await fs.readFile(path.join(root, file), 'utf8') }
}
const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
}
const output = JSON.parse(solc.compile(JSON.stringify(input)))
const errors = (output.errors || []).filter((item) => item.severity === 'error')
if (errors.length) {
  for (const item of errors) process.stderr.write(item.formattedMessage + '\\n')
  process.exit(1)
}
const expected = [
  'TronMetaTxForwarder',
  'Restricted1TRAXMeta',
  'OneTraxReserveVaultMeta',
  'NativeTRXPayoutTreasury',
  'TronTransferPayoutRouter',
]
for (const name of expected) {
  const artifact = Object.values(output.contracts || {}).find((group) => group[name])
  if (!artifact?.[name]?.abi || !artifact[name].evm?.bytecode?.object) {
    throw new Error('Missing compiled ABI or bytecode for ' + name)
  }
}
console.log('Compiled all five sponsored-payout contracts and shared meta-transaction context.')
