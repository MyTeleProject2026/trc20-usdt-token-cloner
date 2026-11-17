import fs from 'node:fs'

const rootPackage = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const frontendPackage = JSON.parse(fs.readFileSync(new URL('../Frontend-Tron-Transfer/package.json', import.meta.url), 'utf8'))
const lock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))

function assert(condition, message) {
  if (!condition) {
    console.error(message)
    process.exitCode = 1
  }
}

for (const name of ['vite', '@vitejs/plugin-react']) {
  assert(!Object.hasOwn(rootPackage.dependencies || {}, name), 'Root ' + name + ' must not be a production dependency.')
  assert(Boolean(rootPackage.devDependencies?.[name]), 'Root ' + name + ' must remain installed as a build-time devDependency.')
  assert(!Object.hasOwn(lock.packages?.['']?.dependencies || {}, name), 'Root lockfile still classifies ' + name + ' as production.')
  assert(Boolean(lock.packages?.['']?.devDependencies?.[name]), 'Root lockfile does not record ' + name + ' as a devDependency.')
}

for (const name of ['vite', '@vitejs/plugin-react', 'solc']) {
  assert(!Object.hasOwn(frontendPackage.dependencies || {}, name), 'Frontend ' + name + ' must not be a production dependency.')
  assert(Boolean(frontendPackage.devDependencies?.[name]), 'Frontend ' + name + ' must remain installed as a build-time devDependency.')
}

// These packages form the currently affected Vite glob-matching/build-tool chain.
// Check every installed copy, not just the currently expected nested paths, so a
// future npm dedupe or dependency-tree reshuffle cannot move a copy into prod.
const buildOnlyPackages = new Set(['vite', '@vitejs/plugin-react', 'tinyglobby', 'fdir', 'picomatch'])
const seenBuildOnlyPackages = new Set()

for (const [packagePath, entry] of Object.entries(lock.packages || {})) {
  const packageName = packagePath.split('node_modules/').pop()
  if (!buildOnlyPackages.has(packageName)) continue

  seenBuildOnlyPackages.add(packageName)
  assert(
    entry.dev === true,
    'Build-only package must remain dev-only in lockfile: ' + packagePath,
  )
}

for (const name of ['vite', '@vitejs/plugin-react', 'tinyglobby', 'fdir', 'picomatch']) {
  assert(seenBuildOnlyPackages.has(name), 'Expected locked build-only package is missing: ' + name)
}

if (process.exitCode) throw new Error('Build-tool dependency scope check failed.')
console.log('Build-tool dependency scope verified: every locked Vite, React plugin, tinyglobby, fdir, and Picomatch copy is dev-only.')
