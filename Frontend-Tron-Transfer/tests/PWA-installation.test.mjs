import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = relativePath => readFile(path.join(frontendRoot, relativePath), 'utf8')

test('PWA manifest uses the canonical TRӾ token artwork and standalone app identity', async () => {
  const manifest = JSON.parse(await read('public/manifest.webmanifest'))
  assert.equal(manifest.name, 'Tron Transfer Owner Admin')
  assert.equal(manifest.short_name, 'Tron Transfer')
  assert.equal(manifest.display, 'standalone')
  assert.equal(manifest.scope, '/')
  assert.ok(manifest.icons.some(icon => icon.src === '/trax-token-mark.svg' && icon.type === 'image/svg+xml'))
  await read('public/trax-token-mark.svg')
})

test('document metadata links the same TRӾ artwork and web app manifest', async () => {
  const html = await read('index.html')
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/)
  assert.match(html, /href="\/trax-token-mark\.svg"/)
  assert.match(html, /Tron Transfer Owner Admin/)
})

test('service worker remains network-only and does not cache wallet or API traffic', async () => {
  const worker = await read('public/sw.js')
  assert.match(worker, /event\.respondWith\(fetch\(request\)\)/)
  assert.doesNotMatch(worker, /caches\.open|cache\.put|cache\.addAll/)
  assert.match(worker, /request\.method !== 'GET'/)
  assert.match(worker, /requestUrl\.origin !== self\.location\.origin/)
})

test('install control supports browser prompts and iOS Add to Home Screen guidance', async () => {
  const component = await read('src/PWAInstallButton.jsx')
  assert.match(component, /beforeinstallprompt/)
  assert.match(component, /Add to Home Screen/)
  assert.match(component, /Install app/)
})
