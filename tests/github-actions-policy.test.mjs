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
})

test('public API smoke rejects forged wallet signatures without issuing sessions', async () => {
  const source = await readFile(new URL('public-api-smoke.yml', workflowsDirectory), 'utf8')
  assert.match(source, /api\/auth\/tron\/challenge/)
  assert.match(source, /api\/auth\/tron\/verify/)
  assert.match(source, /signature:\s*"0x"\s*\+\s*"00"\.repeat\(65\)/)
  assert.match(source, /verify_code.*401/)
  assert.match(source, /signature-verification-failed.*signature-address-mismatch/s)
  assert.match(source, /'sessionToken' in data/)
  assert.match(source, /'wallet-identity-only'/)
})
