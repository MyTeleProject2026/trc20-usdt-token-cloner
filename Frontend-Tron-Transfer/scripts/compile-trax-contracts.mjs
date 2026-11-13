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
const outputDir = path.join(frontendRoot, 'src', 'generated')
await fs.mkdir(outputDir, { recursive: true })
await fs.writeFile(path.join(outputDir, 'trax-contract-artifacts.json'), JSON.stringify({
  compiler: 'TRON solc 0.8.25',
  optimizer: { enabled: true, runs: 200 },
  token,
  vault,
}))
console.log('TRӾ and native TRX reserve vault compiled with TRON solc 0.8.25.')
