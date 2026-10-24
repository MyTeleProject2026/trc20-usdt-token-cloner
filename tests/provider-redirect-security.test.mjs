import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
async function read(path) {
  return readFile(new URL(path, root), 'utf8')
}
function count(source, expression) {
  return [...source.matchAll(expression)].length
}

test('all authenticated Tatum, TRON gateway, and GasFree reads reject redirects', async () => {
  const paths = [
    'server/tatum-client.mjs',
    'server/routes/tatum.mjs',
    'server/sponsor-resources.mjs',
    'server/sponsor-funding.mjs',
    'server/sponsor-resource-delegation-verifier.mjs',
    'server/gasfree-client.mjs',
    'server/gasfree-chain-verifier.mjs',
  ]
  const sources = await Promise.all(paths.map(read))
  for (let index = 0; index < paths.length; index += 1) {
    assert.match(
      sources[index],
      /redirect:\s*'error'/,
      paths[index] + ' must reject redirects on authenticated provider calls',
    )
  }

  assert.equal(count(sources[0], /redirect:\s*'error'/g), 1)
  assert.equal(count(sources[1], /redirect:\s*'error'/g), 3)
  assert.equal(count(sources[2], /redirect:\s*'error'/g), 1)
  assert.equal(count(sources[3], /redirect:\s*'error'/g), 2)
  assert.equal(count(sources[4], /redirect:\s*'error'/g), 1)
  assert.equal(count(sources[5], /redirect:\s*'error'/g), 1)
  assert.equal(count(sources[6], /redirect:\s*'error'/g), 1)
})

test('Tatum KMS remains a separately approved custody service, not an implicit web-app dependency', async () => {
  const packageJson = JSON.parse(await read('package.json'))
  const envExample = await read('.env.example')
  const kmsAudit = await read('docs/TATUM_KMS_INTEGRATION_AUDIT.md')
  const gasfreeRoute = await read('server/routes/gasfree.mjs')

  assert.equal(packageJson.dependencies?.['@tatumio/tatum-kms'], undefined)
  assert.doesNotMatch(envExample, /^TATUM_KMS_[A-Z0-9_]+=/m)
  assert.match(kmsAudit, /separately administered service/)
  assert.match(kmsAudit, /four-eye callback/)
  assert.match(gasfreeRoute, /sponsored-submission-disabled/)
  assert.match(gasfreeRoute, /submissionEnabled: false/)
})
