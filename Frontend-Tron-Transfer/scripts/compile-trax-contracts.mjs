import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const frontendRoot = path.resolve(here, '..')
const repositoryRoot = path.resolve(frontendRoot, '..')
const tronboxProject = path.join(frontendRoot, 'trax-build')
const contractsDir = path.join(tronboxProject, 'contracts')
const tronboxBin = path.join(frontendRoot, 'node_modules', '.bin', 'tronbox')

await fs.access(tronboxBin)
await fs.mkdir(contractsDir, { recursive: true })
await fs.copyFile(path.join(repositoryRoot, 'contracts', 'Restricted1TRAX.sol'), path.join(contractsDir, 'Restricted1TRAX.sol'))
await fs.copyFile(path.join(repositoryRoot, 'contracts', 'OneTraxReserveVault.sol'), path.join(contractsDir, 'OneTraxReserveVault.sol'))
const metaContractFiles = [
  'MetaTxContext.sol',
  'TronMetaTxForwarder.sol',
  'Restricted1TRAXMeta.sol',
  'OneTraxReserveVaultMeta.sol',
  'NativeTRXPayoutTreasury.sol',
  'TronTransferPayoutRouter.sol',
]
for (const file of metaContractFiles) {
  await fs.copyFile(path.join(repositoryRoot, 'contracts', file), path.join(contractsDir, file))
}

// This nested project is CommonJS because TronBox's documented config file uses module.exports.
// The main frontend remains an ES-module project.
execFileSync(tronboxBin, ['compile', '--compile-all'], {
  cwd: tronboxProject,
  stdio: 'inherit',
})

async function readArtifact(name) {
  const artifactPath = path.join(tronboxProject, 'build', 'contracts', name + '.json')
  const artifact = JSON.parse(await fs.readFile(artifactPath, 'utf8'))
  if (artifact.contractName !== name || !Array.isArray(artifact.abi) || typeof artifact.bytecode !== 'string') {
    throw new Error('TronBox artifact is incomplete for ' + name)
  }
  const bytecode = artifact.bytecode.replace(/^0x/, '')
  if (!bytecode || !/^[0-9a-f]+$/i.test(bytecode)) throw new Error('Invalid TRON bytecode for ' + name)
  return { contractName: name, abi: artifact.abi, bytecode }
}

const token = await readArtifact('Restricted1TRAX')
const vault = await readArtifact('OneTraxReserveVault')
const metaArtifacts = {
  forwarder: await readArtifact('TronMetaTxForwarder'),
  token: await readArtifact('Restricted1TRAXMeta'),
  vault: await readArtifact('OneTraxReserveVaultMeta'),
  nativeTreasury: await readArtifact('NativeTRXPayoutTreasury'),
  payoutRouter: await readArtifact('TronTransferPayoutRouter'),
}
const outputDir = path.join(frontendRoot, 'src', 'generated')
await fs.mkdir(outputDir, { recursive: true })

const legacyArtifacts = {
  compiler: 'TRON solc 0.8.25',
  optimizer: { enabled: true, runs: 200 },
  token,
  vault,
}
await fs.writeFile(
  path.join(outputDir, 'trax-contract-artifacts.js'),
  'export default ' + JSON.stringify(legacyArtifacts) + ';\n',
)

const sponsoredArtifacts = {
  compiler: 'TRON solc 0.8.25',
  optimizer: { enabled: true, runs: 200 },
  ...metaArtifacts,
}
await fs.writeFile(
  path.join(outputDir, 'tron-sponsored-payout-artifacts.js'),
  'export default ' + JSON.stringify(sponsoredArtifacts) + ';\n',
)
console.log('TRӾ legacy and meta-aware token, forwarder, reserve vault, treasury, and atomic dual-asset payout contracts compiled with TRON solc 0.8.25.')
