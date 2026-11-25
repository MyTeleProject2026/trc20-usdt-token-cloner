import process from 'node:process'
import { evaluateProductionAcceptance } from '../production-acceptance-assessment.mjs'

const baseUrl = String(process.env.TRON_TRANSFER_API_BASE_URL || '').replace(/\/$/, '')
if (!baseUrl) {
  process.stderr.write('TRON_TRANSFER_API_BASE_URL is required; no production target is assumed.\n')
  process.exit(2)
}
let origin
try {
  origin = new URL(baseUrl)
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash) {
    throw new Error('invalid-origin')
  }
} catch {
  process.stderr.write('TRON_TRANSFER_API_BASE_URL must be a clean HTTPS origin.\n')
  process.exit(2)
}

async function get(path) {
  const response = await fetch(new URL(path, origin), {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(path + ': HTTP ' + response.status)
  return payload
}

try {
  const [health, report] = await Promise.all([
    get('/health'),
    get('/api/acceptance/production'),
  ])
  const result = evaluateProductionAcceptance(health, report)
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  if (!result.passed) process.exitCode = 1
} catch (error) {
  process.stderr.write('Production acceptance smoke test failed: ' + String(error?.message || 'unknown error') + '\n')
  process.exitCode = 1
}
