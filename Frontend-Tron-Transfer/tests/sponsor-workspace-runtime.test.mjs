import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/SponsorWalletManager.jsx', import.meta.url), 'utf8')

test('Sponsor resource-derived values are initialized before effects reference them', () => {
  const derived = source.indexOf('const energyTargetValid =')
  const effect = source.indexOf('if (!wallet || !snapshot || !energyTargetValid || !bandwidthTargetValid)')
  assert.notEqual(derived, -1)
  assert.notEqual(effect, -1)
  assert.ok(derived < effect, 'resource validation and deficit values must be initialized before the effect dependency array is evaluated')
  for (const name of ['bandwidthTargetValid', 'ownerEnergyDeficit', 'ownerBandwidthDeficit']) {
    assert.ok(source.indexOf(`const ${name} =`) < effect, `${name} must be initialized before the resource alert effect`)
  }
})

test('Sponsor workspace receives the active route from App', () => {
  assert.match(source, /function SponsorWalletManager\(\{\s*activePage\s*=\s*'sponsor'/)
  for (const [id, route] of [['sponsor-overview', 'sponsor'], ['sponsor-resources', 'sponsor-resources'], ['sponsor-automation', 'sponsor-automation'], ['sponsor-activity', 'sponsor-activity']]) assert.ok(source.includes(`activePage === "${route}" && <section id="${id}"`), `${id} must mount only on its own page`)
  assert.ok(!source.includes('scrollIntoView'), 'page navigation must not depend on scrolling hidden sections')
  assert.ok(source.includes('if (!workspaceActive) return undefined'), 'Sponsor API status polling must pause outside its workspace')
  assert.ok(source.includes('recordActivity, workspaceActive'), 'Sponsor history polling must pause outside its workspace')
})

test('Sponsor workspace pages are isolated and wallet-locked routes have a recovery path', () => {
  for (const id of ['sponsor-overview', 'sponsor-resources', 'sponsor-automation', 'sponsor-activity']) {
    assert.ok(source.includes(`id="${id}"`), `${id} page must exist`)
  }
  assert.match(source, /Sponsor Wallet is locked/)
  assert.match(source, /onNavigate\('sponsor'\)/)
})

test('Sponsor workspace render errors are contained by an application error boundary', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
  assert.match(app, /class SponsorWorkspaceErrorBoundary extends React\.Component/)
  assert.ok(app.includes('<SponsorWorkspaceErrorBoundary activePage={activePage} onNavigate={setActivePage}>'))
  assert.match(app, /This Sponsor page could not be displayed/)
})

test('Owner Admin re-authentication state is cleared on Sponsor wallet lock and workspace exit', () => {
  assert.match(source, /if \(!wallet \|\| !workspaceActive\) \{\s*setOwnerAdminPassword\(''\)\s*setOwnerAdminReady\(false\)/)
  assert.match(source, /\[wallet, workspaceActive\]/)
  assert.match(source, /setOwnerAdminReady\(false\)/)
})

test('Sponsor TronWeb instance is initialized before any effect dependency reads it', () => {
  const declaration = source.indexOf("const tronWeb = useMemo(() => wallet?.privateKey ? createSponsorTronWeb(wallet.privateKey) : null, [wallet])")
  const firstEffectRead = source.indexOf("if (!workspaceActive || !wallet?.address || !tronWeb)")
  assert.notEqual(declaration, -1, 'Sponsor TronWeb memo must exist')
  assert.notEqual(firstEffectRead, -1, 'resource history effect must exist')
  assert.ok(declaration < firstEffectRead, 'tronWeb must be initialized before effect callbacks and dependency arrays reference it')
})


test('Sponsor password recovery and account session controls stay inside the existing workspace',()=>{
  assert.ok(source.includes('sponsorAuth.recoverPassword(authRecoveryToken.trim(), authPassword)'))
  assert.ok(source.includes('sponsorAuth.changePassword(currentSponsorPassword, newSponsorPassword)'))
  assert.ok(source.includes('sponsorAuth.sessions()'))
  assert.ok(source.includes('sponsorAuth.revokeSession(sessionId)'))
  assert.ok(source.includes('sponsorAuth.revokeOtherSessions()'))
  assert.ok(source.includes('Sponsor account security and active sessions'))
  assert.ok(source.includes('Recover Sponsor password'))
  assert.ok(source.includes('Change Sponsor password'))
  assert.ok(source.includes("activePage === \"sponsor\" && wallet"))
})

test('Sponsor local signer is locked immediately when leaving the Sponsor workspace', () => {
  const lockOnExit = source.indexOf("if (workspaceActive) return\n    if (wallet?.address) lockWallet('manual')")
  const idleEffect = source.indexOf("if (!wallet?.address || !workspaceActive) return undefined")
  const lockCallback = source.indexOf("setWallet(null)")
  assert.notEqual(lockOnExit, -1, 'switching to Owner workspace must revoke Sponsor access')
  assert.notEqual(idleEffect, -1, 'idle timer must not remain active outside Sponsor workspace')
  assert.notEqual(lockCallback, -1, 'locking must clear the in-memory Sponsor signer')
  assert.ok(lockOnExit < idleEffect, 'workspace-exit lock must be registered before idle monitoring')
})

test('Sponsor lock clears local key-import, keystore and password inputs', () => {
  const lockStart = source.indexOf('const lockWallet = useCallback')
  const lockEnd = source.indexOf('}, [wallet?.address, recordSecurityEvent', lockStart)
  const lockSource = source.slice(lockStart, lockEnd)
  for (const setter of ['setCredential(\'\')','setKeystorePassword(\'\')','setVaultPassword(\'\')','setUnlockPassword(\'\')','setAuthPassword(\'\')','setCurrentSponsorPassword(\'\')','setNewSponsorPassword(\'\')','setConfirmSponsorPassword(\'\')']) {
    assert.ok(lockSource.includes(setter), 'lock must clear ' + setter)
  }
  assert.ok(source.includes('// Clear pending import/unlock credentials even when no vault has been unlocked yet.'))
  assert.ok(source.includes('setCredential(\'\')'))
})


test('Sponsor transaction execution is independent of Owner Admin authentication', () => {
  const transactionStart = source.indexOf('async function submitResourceTransaction(')
  const transactionEnd = source.indexOf('async function runResourceAutomation(', transactionStart)
  const transaction = source.slice(transactionStart, transactionEnd)
  const automationEnd = source.indexOf('async function cancelLastPreparedOperation(', transactionEnd)
  const automation = source.slice(transactionEnd, automationEnd)
  assert.notEqual(transactionStart, -1)
  assert.notEqual(transactionEnd, -1)
  assert.doesNotMatch(transaction, /ensureOwnerAdmin|ownerCsrfToken|ownerAdminCsrfToken/)
  assert.doesNotMatch(automation, /ensureOwnerAdmin|ownerCsrfToken|ownerAdminCsrfToken/)
  assert.match(transaction, /csrfToken: authCsrfToken/)
  assert.match(automation, /csrfToken: authCsrfToken/)
  assert.match(source, /Sponsor transactions require only the independent Sponsor session and Sponsor CSRF proof/)
  assert.match(source, /Owner authentication is not required to operate the Sponsor wallet/)
})

test('Owner Admin authentication is retained for guarded Sponsor ledger bootstrap', () => {
  const bootstrapStart = source.indexOf('async function bootstrapSponsorLedger()')
  const bootstrapEnd = source.indexOf('async function loginSponsorWallet()', bootstrapStart)
  assert.match(source.slice(bootstrapStart, bootstrapEnd), /ensureOwnerAdmin\(\)/)
})

test('Owner Admin panel explains its bootstrap-only authorization boundary', () => {
  assert.match(source, /Sponsor ledger bootstrap authorization/)
  assert.match(source, /only to initialize the paused Sponsor ledger schema/)
  assert.match(source, /Sponsor transactions require only the independent Sponsor session/)
})
