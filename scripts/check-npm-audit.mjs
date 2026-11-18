import fs from 'node:fs'

const reportPath = process.argv[2]
if (!reportPath) {
  console.error('Usage: node scripts/check-npm-audit.mjs <npm-audit-json-file>')
  process.exit(2)
}

let report
try {
  report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
} catch (error) {
  console.error('Could not read npm audit JSON:', error.message)
  process.exit(1)
}

if (report.error || !report.metadata?.vulnerabilities || !report.vulnerabilities) {
  console.error('npm audit did not return a complete vulnerability report.')
  process.exit(1)
}

// Temporary, narrowly scoped exception: the upstream advisory currently has no
// published patched picomatch version. Re-check this exception before expiry.
const exception = {
  advisory: 'GHSA-fc5q-39xc-vjpf',
  packageName: 'picomatch',
  expiresAt: '2026-12-02T23:59:59.999Z',
}
const now = Date.now()
const vulnerabilities = report.vulnerabilities
const cache = new Map()
const exceptedDependencyChain = new Set(['picomatch', 'fdir', 'tinyglobby', 'vite'])

function isOnlyTemporarilyExceptedAdvisory(name, trail = new Set()) {
  if (cache.has(name)) return cache.get(name)
  const item = vulnerabilities[name]
  if (!item || trail.has(name) || !exceptedDependencyChain.has(name)) return false
  const nextTrail = new Set(trail)
  nextTrail.add(name)
  const via = Array.isArray(item.via) ? item.via : []
  if (via.length === 0
    || item.severity !== 'high'
    || !(item.fixAvailable === false || item.fixAvailable == null || item.fixAvailable?.isSemVerMajor === true)
    || Date.parse(exception.expiresAt) <= now) return false

  const allowed = via.every((entry) => {
    if (typeof entry === 'string') {
      return exceptedDependencyChain.has(entry)
        && isOnlyTemporarilyExceptedAdvisory(entry, nextTrail)
    }
    if (entry?.severity !== 'high') return true
    return String(entry?.url || '').includes(exception.advisory)
  })
  cache.set(name, allowed)
  return allowed
}

const blocking = []
const excepted = []
for (const [name, item] of Object.entries(vulnerabilities)) {
  if (!['critical', 'high'].includes(item.severity)) continue
  if (isOnlyTemporarilyExceptedAdvisory(name)) {
    excepted.push({ name, severity: item.severity, range: item.range })
  } else {
    blocking.push({ name, severity: item.severity, range: item.range })
  }
}

console.log('npm audit severity totals:', JSON.stringify(report.metadata.vulnerabilities))
if (excepted.length) {
  console.warn(
    'TEMPORARY SECURITY EXCEPTION ' + exception.advisory
    + ' through ' + exception.expiresAt
    + ': no patched picomatch version is published; only dependency paths whose entire high-severity chain resolves to this exact advisory are excepted.',
  )
  console.warn('Excepted packages:', JSON.stringify(excepted))
}
if (blocking.length) {
  console.error('Blocking critical/high dependency findings:', JSON.stringify(blocking))
  process.exit(1)
}
console.log('Dependency security gate passed: no unexcepted critical/high advisories.')
