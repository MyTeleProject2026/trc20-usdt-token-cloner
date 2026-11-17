import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import solc from 'solc'

const here = path.dirname(fileURLToPath(import.meta.url))
const frontendRoot = path.resolve(here, '..')
const repositoryRoot = path.resolve(frontendRoot, '..')

export function createTRAXVerificationBundle(source, compilerVersion) {
  if (typeof source !== 'string' || !source.trim()) {
    throw new Error('Restricted1TRAX.sol source is required to create a verification bundle.')
  }
  if (typeof compilerVersion !== 'string' || !compilerVersion.startsWith('0.8.25+')) {
    throw new Error('TRӾ source verification requires the pinned Solidity compiler 0.8.25.')
  }

  const standardInput = {
    language: 'Solidity',
    sources: {
      'Restricted1TRAX.sol': { content: source },
    },
    settings: {
      evmVersion: 'paris',
      optimizer: { enabled: true, runs: 1 },
      outputSelection: {
        '*': {
          '*': ['abi', 'metadata', 'evm.bytecode', 'evm.deployedBytecode'],
        },
      },
    },
  }

  const output = JSON.parse(solc.compile(JSON.stringify(standardInput)))
  const errors = (output.errors || []).filter(item => item.severity === 'error')
  if (errors.length) {
    throw new Error('TRӾ verification bundle compilation failed: ' + errors.map(item => item.message).join('; '))
  }

  const contract = output.contracts?.['Restricted1TRAX.sol']?.Restricted1TRAX
  const runtimeBytecode = contract?.evm?.deployedBytecode?.object || ''
  if (!contract || !/^(?:[0-9a-f]{2})+$/i.test(runtimeBytecode)) {
    throw new Error('Solidity did not produce valid Restricted1TRAX runtime bytecode.')
  }

  return {
    schemaVersion: 1,
    contractName: 'Restricted1TRAX',
    network: 'TRON Mainnet',
    compilerVersion,
    compilerLongVersion: compilerVersion,
    evmVersion: 'paris',
    optimizer: { enabled: true, runs: 1 },
    sourceFile: 'Restricted1TRAX.sol',
    contractAddress: null,
    constructorArguments: '',
    verificationStatus: 'not-submitted-no-deployed-address',
    runtimeBytecodeSha256: createHash('sha256').update(runtimeBytecode, 'hex').digest('hex'),
    standardJsonInput: standardInput,
    compilerMetadata: JSON.parse(contract.metadata),
    instructions: [
      'This bundle prepares exact Solidity Standard JSON verification input; it does not submit verification to TRONSCAN.',
      'After a Mainnet deployment is confirmed, set the deployed contract address in the TRONSCAN verification form.',
      'Keep compiler version, EVM version, optimizer settings, source path and constructor arguments identical.',
      'Confirm the submitted on-chain runtime bytecode matches the compiled artifact before marking verification complete.',
    ],
  }
}

async function writeBundle() {
  const source = await fs.readFile(path.join(repositoryRoot, 'contracts', 'Restricted1TRAX.sol'), 'utf8')
  const compilerVersion = solc.version()
  const bundle = createTRAXVerificationBundle(source, compilerVersion)
  const outputDir = path.join(frontendRoot, 'dist', 'trax-verification')
  await fs.mkdir(outputDir, { recursive: true })
  const outputPath = path.join(outputDir, 'tronscan-standard-json-verification.json')
  await fs.writeFile(outputPath, JSON.stringify(bundle, null, 2) + '\n', 'utf8')
  process.stdout.write('Prepared TRӾ TRONSCAN verification bundle at dist/trax-verification/tronscan-standard-json-verification.json\n')
  process.stdout.write('No contract address was supplied; this bundle is preparation only and does not claim source verification.\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await writeBundle()
}
