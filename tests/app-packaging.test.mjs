import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8')

test('Capacitor packages the bundled UI locally with a stable app ID and HTTPS Android origin', async () => {
  const config = JSON.parse(await read('capacitor.config.json'))
  assert.equal(config.appId, 'com.myteleproject.trontokenstudio')
  assert.equal(config.appName, 'TRON Token Studio')
  assert.equal(config.webDir, 'dist-mobile')
  assert.equal(config.server.androidScheme, 'https')
  assert.equal(config.server.hostname, 'localhost')
  assert.equal(Object.hasOwn(config.server, 'url'), false, 'production APK must bundle the app instead of pointing at a live-reload URL')
})

test('desktop shell uses an isolated renderer and a constrained secure custom asset origin', async () => {
  const main = await read('desktop/main.cjs')
  assert.match(main, /nodeIntegration:\s*false/)
  assert.match(main, /contextIsolation:\s*true/)
  assert.match(main, /sandbox:\s*true/)
  assert.match(main, /registerSchemesAsPrivileged/)
  assert.match(main, /supportFetchAPI:\s*true/)
  assert.match(main, /corsEnabled:\s*true/)
  assert.match(main, /parsed\.hostname !== APP_HOST/)
  assert.match(main, /target\.protocol !== 'https:'/)
  assert.match(main, /path\.resolve\(WEB_ROOT, relativePath\)/)
  assert.match(main, /target\.startsWith\(WEB_ROOT \+ path\.sep\)/)
  assert.doesNotMatch(main, /nodeIntegration:\s*true|webviewTag:\s*true/)
})

test('Windows installer packages the bundled renderer and pins the Electron runtime', async () => {
  const config = await read('electron-builder.yml')
  assert.match(config, /appId:\s*com\.myteleproject\.trontokenstudio/)
  assert.match(config, /electronVersion:\s*45\.0\.0/)
  assert.match(config, /dist-electron\/\*\*/)
  assert.match(config, /target:\s*nsis/)
  assert.match(config, /artifactName:\s*TRON-Token-Studio-Setup-/)
})

test('installer workflow builds both platforms, preserves the lockfile, and uploads explicit artifacts', async () => {
  const workflow = await read('.github/workflows/package-installers.yml')
  assert.match(workflow, /npm ci/)
  assert.match(workflow, /--package-lock=false/)
  assert.match(workflow, /vite build --base=\.\//)
  assert.match(workflow, /assembleDebug/)
  assert.match(workflow, /electron-builder --win nsis --x64 --publish never/)
  assert.match(workflow, /name: tron-token-studio-android-debug-apk/)
  assert.match(workflow, /name: tron-token-studio-windows-x64-unsigned-installer/)
})
