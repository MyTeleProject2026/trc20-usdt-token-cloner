import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const frontendRoot = path.resolve(here, '..')
const repositoryRoot = path.resolve(frontendRoot, '..')
const tronboxBin = path.join(frontendRoot, 'node_modules', '.bin', 'tronbox')
const configPath = path.join(repositoryRoot, 'tronbox-config.cjs')

await fs.access(tronboxBin)
await fs.access(configPath)

// Use TronBox's bundled TRON Solidity compiler (tron-solc), not upstream solc.
execFileSync(tronboxBin, ['compile', '--all', '--config', configPath], {
  cwd: repositoryRoot,
  stdio: 'inherit',
})

async function readArtifact(name, contractName) {
  const artifactPath = path.join(repositoryRoot, 'build', 'contracts', name + '.json')
  const artifact = JSON.parse(await fs.readFile(artifactPath, 'utf8'))
  if (artifact.contractName !== contractName || !Array.isArray(artifact.abi) || typeof artifact.bytecode !== 'string') {
    throw new Error('TronBox artifact is incomplete for ' + contractName)
  }
  const bytecode = artifact.bytecode.replace(/^0x/, '')
  if (!bytecode || !/^[0-9a-f]+$/i.test(bytecode)) throw new Error('Invalid TRON bytecode for ' + contractName)
  return { contractName, abi: artifact.abi, bytecode }
}

const token = await readArtifact('Restricted1TRAX', 'Restricted1TRAX')
const vault = await readArtifact('OneTraxReserveVault', 'OneTraxReserveVault')
const outputDir = path.join(frontendRoot, 'src', 'generated')
await fs.mkdir(outputDir, { recursive: true })
await fs.writeFile(path.join(outputDir, 'trax-contract-artifacts.json'), JSON.stringify({
  compiler: 'TRON solc 0.8.25',
  optimizer: { enabled: true, runs: 200 },
  token,
  vault,
}))
console.log('TRӾ and reserve vault compiled with TRON solc 0.8.25.')
