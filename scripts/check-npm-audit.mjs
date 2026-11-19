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

const blocking = Object.entries(report.vulnerabilities)
  .filter(([, item]) => ['critical', 'high'].includes(item.severity))
  .map(([name, item]) => ({ name, severity: item.severity, range: item.range }))

console.log('npm audit severity totals:', JSON.stringify(report.metadata.vulnerabilities))
if (blocking.length) {
  console.error('Blocking critical/high dependency findings:', JSON.stringify(blocking))
  process.exit(1)
}
console.log('Dependency security gate passed: no critical/high advisories.')
