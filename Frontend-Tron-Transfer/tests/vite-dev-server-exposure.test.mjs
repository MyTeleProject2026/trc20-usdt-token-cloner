import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const viteConfig = await readFile(new URL('../vite.config.js', import.meta.url), 'utf8')

test('Vite development server stays on loopback unless an explicit safe override is reviewed', () => {
  assert.equal(packageJson.scripts.dev.includes('--host'), false, 'dev script must not expose Vite on all network interfaces')
  assert.doesNotMatch(viteConfig, /\bhost\s*:\s*['"](?:0\.0\.0\.0|true|\*|::)['"]/)
})
