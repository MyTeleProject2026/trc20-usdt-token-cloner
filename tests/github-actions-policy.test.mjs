import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'

const workflowsDirectory = new URL('../.github/workflows/', import.meta.url)

test('third-party GitHub Actions are pinned to immutable full commit SHAs', async () => {
  const files = (await readdir(workflowsDirectory)).filter((name) => /\.ya?ml$/i.test(name))
  const references = []

  for (const file of files) {
    const source = await readFile(new URL(file, workflowsDirectory), 'utf8')
    const usesPattern = /^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm

    for (const match of source.matchAll(usesPattern)) {
      const reference = match[1]
      if (reference.startsWith('./') || reference.startsWith('docker://')) continue
      const shaMatch = reference.match(/^[^@]+@([a-f0-9]{40})$/i)
      references.push({ file, reference, pinned: Boolean(shaMatch) })
    }
  }

  assert.ok(references.length > 0, 'workflow directory should contain action references')
  const unpinned = references.filter((item) => !item.pinned)
  assert.deepEqual(unpinned, [], `Unpinned GitHub Actions: ${JSON.stringify(unpinned)}`)
})

test('authoritative CI keeps PostgreSQL integration, tests, and production build in one job', async () => {
  const source = await readFile(new URL('ci.yml', workflowsDirectory), 'utf8')
  assert.match(source, /image:\s*postgres:16/)
  assert.match(source, /SPONSOR_PG_INTEGRATION:\s*["']?1["']?/)
  assert.match(source, /run:\s*npm test/)
  assert.match(source, /run:\s*npm run build/)
  assert.match(source, /uses:\s*actions\/checkout@[a-f0-9]{40}/i)
  assert.match(source, /uses:\s*actions\/setup-node@[a-f0-9]{40}/i)
  assert.match(source, /^\s*pull_request:\s*$/m, 'authoritative CI must validate pull requests')

  const secondaryWorkflow = await readFile(new URL('webpack.yml', workflowsDirectory), 'utf8')
  assert.doesNotMatch(
    secondaryWorkflow,
    /^\s*pull_request:\s*$/m,
    'the Node version matrix must not duplicate the authoritative pull-request test/build run',
  )
  assert.match(
    secondaryWorkflow,
    /^permissions:\s*\n\s+contents:\s*read\s*$/m,
    'the Node matrix must use a read-only GITHUB_TOKEN',
  )
  assert.match(
    secondaryWorkflow,
    /^concurrency:\s*\n\s+group:\s*node-matrix-/m,
    'superseded Node matrix runs must share a concurrency group per ref',
  )
  assert.match(
    secondaryWorkflow,
    /^\s+cancel-in-progress:\s*true\s*$/m,
    'newer commits must cancel obsolete matrix runs on the same ref',
  )
  assert.match(
    secondaryWorkflow,
    /^\s+timeout-minutes:\s*20\s*$/m,
    'matrix jobs must have a bounded execution time',
  )
})

test('production smoke monitors the existing Tron Transfer frontend and Resource API', async () => {
  const source = await readFile(new URL('public-api-smoke.yml', workflowsDirectory), 'utf8')
  assert.match(source, /https:\/\/tron-transfer\.onrender\.com\//)
  assert.match(source, /https:\/\/tron-transfer-resource-api\.onrender\.com\/health/)
  assert.match(source, /data\.status !== "ok"/)
  assert.doesNotMatch(source, /trc20-usdt-token-cloner-api|nile|testnet/i)
})

test('production uptime probe verifies independent Mainnet RPCs and current Sponsor acceptance fields', async () => {
  const source = await readFile(new URL('tron-transfer-production-uptime.yml', workflowsDirectory), 'utf8')
  assert.match(source, /api\/mainnet\/provider-health/)
  assert.match(source, /api\/mainnet\/explorer-health/)
  assert.match(source, /parsed\?\.apiKeyConfigured === true/)
  assert.match(source, /parsed\?\.probeContractIndexed === true/)
  assert.match(source, /API key=/)
  assert.match(source, /public read-only/)
  assert.match(source, /apiKeySource/)
  assert.doesNotMatch(source, /TRONSCAN_PRO_API_KEY is not configured/)
  assert.match(source, /providerPriority\?\.\[0\] === 'tatum'/)
  assert.match(source, /provider\?\.id === 'tatum'/)
  assert.match(source, /provider\?\.id === 'trongrid'/)
  assert.match(source, /ownerAdminSessionConfiguredForLedgerRelease/)
  assert.match(source, /sponsorWalletEnrolled/)
  assert.match(source, /databaseIdentityMatches/)
  assert.match(source, /sponsorAddressMatches/)
  assert.match(source, /ownerSignerAcceptanceVerified/)
  assert.match(source, /sponsorSignerAcceptanceVerified/)
  assert.match(source, /acceptanceBlockedChecks/)
  assert.match(source, /writesReleaseBlockedChecks/)
  assert.match(source, /writesReleaseAvailable/)
  assert.doesNotMatch(source, /adminTokenRequired|adminTokenConfigured/)
})


test('production uptime probe verifies both sign-only endpoints reject unauthenticated requests', async () => {
  const source = await readFile(new URL('tron-transfer-production-uptime.yml', workflowsDirectory), 'utf8')
  assert.match(source, /api\/wallet-auth\/owner\/signing-challenge/)
  assert.match(source, /api\/wallet-auth\/sponsor\/signing-challenge/)
  assert.match(source, /response\.status === 401/)
  assert.match(source, /WALLET_SESSION_REQUIRED/)
})


test('production probe treats only the expected unauthenticated signer response as healthy', async () => {
  const source = await readFile(new URL('tron-transfer-production-uptime.yml', workflowsDirectory), 'utf8')
  assert.match(source, /const expectedUnauthorized =/)
  assert.match(source, /response\.status === 401/)
  assert.match(source, /parsed\?\.error === 'WALLET_SESSION_REQUIRED'/)
  assert.match(source, /\(response\.ok \|\| expectedUnauthorized\)/)
})


test('production probe keeps parsed response JSON in scope for expected auth status checks', async () => {
  const source = await readFile(new URL('tron-transfer-production-uptime.yml', workflowsDirectory), 'utf8')
  assert.match(source, /let parsed = null;\s+if \(target\.expectJson\)/)
  assert.doesNotMatch(source, /if \(target\.expectJson\) \{\s+const parsed = JSON\.parse\(body\)/)
})
