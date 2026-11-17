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

for (const key of ['node_modules/vite', 'node_modules/vite/node_modules/picomatch', 'node_modules/tinyglobby/node_modules/picomatch']) {
  const entry = lock.packages?.[key]
  assert(Boolean(entry), 'Expected locked build-tool package is missing: ' + key)
  assert(entry?.dev === true, 'Expected build-tool package to be dev-only in lockfile: ' + key)
}

if (process.exitCode) throw new Error('Build-tool dependency scope check failed.')
console.log('Build-tool dependency scope verified: Vite, React plugin, and their Picomatch chain are dev-only.')
