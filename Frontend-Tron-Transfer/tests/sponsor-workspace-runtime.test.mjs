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
  assert.match(app, /A render error does not confirm transaction status/)
  assert.match(app, /Check the durable Sponsor ledger and solidified Mainnet receipt before retrying/)
  assert.doesNotMatch(app, /No transaction was submitted/)
})

test('Sponsor workspace reuses the paired Owner Admin session and a role-specific device key without a second password', () => {
  assert.match(source, /ownerAdminPassword: sharedOwnerPassword/)
  assert.match(source, /sponsorAuth\.session\(\)/)
  assert.match(source, /ownerAuth\.session\(\)/)
  assert.match(source, /unlockSponsorDeviceWallet\(\)/)
  assert.match(source, /saveSponsorDeviceWallet\(account\)/)
  assert.match(source, /Sponsor workspace automatically authorized/)
  assert.match(source, /deviceUnlockReady/)
  assert.doesNotMatch(source, /Owner account password<input/)
})

test('Switching between Owner and Sponsor workspaces retains the paired sessions; explicit Owner logout clears Sponsor signer', () => {
  assert.match(source, /Workspace navigation is not logout/)
  assert.match(source, /tron-transfer:owner-session-ended/)
  assert.match(source, /autoRestoreBlocked\.current = true/)
  assert.doesNotMatch(source, /if \(wallet\?\.address\) lockWallet\('manual'\)\s*if \(!wallet\?\.address && managedSponsorAddress\) lockWallet\('manual'\)/)
})

test('Sponsor TronWeb instance is initialized before any effect dependency reads it', () => {
  const declaration = source.indexOf("const tronWeb = useMemo(() => wallet?.privateKey ? createSponsorTronWeb(wallet.privateKey) : null, [wallet])")
  const firstEffectRead = source.indexOf("if (!workspaceActive || !wallet?.address || !tronWeb)")
  assert.notEqual(declaration, -1, 'Sponsor TronWeb memo must exist')
  assert.notEqual(firstEffectRead, -1, 'resource history effect must exist')
  assert.ok(declaration < firstEffectRead, 'tronWeb must be initialized before effect callbacks and dependency arrays reference it')
})


test('Owner Admin password recovery and Sponsor session controls stay inside the existing workspace',()=>{
  assert.ok(source.includes('ownerAuth.recoverPassword(authRecoveryToken.trim(), authPassword)'))
  assert.ok(source.includes('ownerAuth.changePassword(currentSponsorPassword, newSponsorPassword)'))
  assert.ok(source.includes('sponsorAuth.sessions()'))
  assert.ok(source.includes('sponsorAuth.revokeSession(sessionId)'))
  assert.ok(source.includes('sponsorAuth.revokeOtherSessions()'))
  assert.ok(source.includes('Sponsor account security and active sessions'))
  assert.ok(source.includes('Recover Owner Admin password'))
  assert.ok(source.includes('Change Owner Admin password'))
  assert.ok(source.includes("activePage === \"sponsor\" && wallet"))
})

test('Sponsor local signer remains available across workspace switches and is cleared on Owner logout', () => {
  assert.match(source, /Workspace navigation is not logout/)
  assert.match(source, /tron-transfer:owner-session-ended/)
  assert.match(source, /const lockWallet = useCallback/)
  assert.match(source, /setWallet\(null\)/)
  assert.match(source, /if \(!wallet\?\.address \|\| !workspaceActive\) return undefined/)
})

test('Sponsor lock clears local key-import, keystore and password inputs', () => {
  const lockStart = source.indexOf('const lockWallet = useCallback')
  const lockEnd = source.indexOf('}, [wallet?.address, recordSecurityEvent', lockStart)
  const lockSource = source.slice(lockStart, lockEnd)
  for (const setter of ['setCredential(\'\')','setKeystorePassword(\'\')','setVaultPassword(\'\')','setUnlockPassword(\'\')','setAuthPassword(\'\')','setCurrentSponsorPassword(\'\')','setNewSponsorPassword(\'\')','setConfirmSponsorPassword(\'\')']) {
    assert.ok(lockSource.includes(setter), 'lock must clear ' + setter)
  }
  assert.ok(source.includes('// Workspace navigation is not logout: retain paired sessions and unlocked signers in memory.'))
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
  assert.match(automation, /submitResourceTransaction\(plan\.action, \{ amount: amountTrx, resource \}\)/)
  assert.match(source, /Sponsor transactions require only the independent Sponsor session and Sponsor CSRF proof/)
  assert.match(source, /Owner authentication is checked independently/)
  assert.match(source, /Sponsor password session did not return the enrolled Mainnet address/)
  assert.doesNotMatch(source.slice(source.indexOf('async function loginSponsorWallet()'), source.indexOf('async function recoverSponsorPassword()')), /Authenticate the configured Owner account first/)
  assert.match(source, /sponsorApiRequest\('\/api\/sponsor\/status'\)/)
})

test('Owner Admin authentication is retained for guarded Sponsor ledger bootstrap', () => {
  const bootstrapStart = source.indexOf('async function bootstrapSponsorLedger()')
  const bootstrapEnd = source.indexOf('async function loginSponsorWallet()', bootstrapStart)
  assert.match(source.slice(bootstrapStart, bootstrapEnd), /ensureOwnerAdmin\(\)/)
})

test('Owner Admin panel explains its guarded bootstrap and write-control boundary', () => {
  assert.match(source, /Owner Admin authorization/)
  assert.match(source, /primary Owner Admin application session authorizes guarded Sponsor administration/)
  assert.match(source, /Sponsor transactions require only the independent Sponsor session/)
  assert.match(source, /Owner authentication boundary: \{sponsorApiStatus\?\.ownerAdminSessionConfiguredForLedgerRelease \? 'guarded bootstrap and pause\/release actions only'/)
})


test('Sponsor first-time enrollment is independent, address-bound, and browser-only', () => {
  const start = source.indexOf('async function enrollSponsorWallet()')
  const end = source.indexOf('async function loginSponsorWallet()', start)
  assert.notEqual(start, -1, 'first-time Sponsor enrollment handler must exist')
  assert.notEqual(end, -1, 'Sponsor login handler must follow enrollment handler')
  const enrollment = source.slice(start, end)
  assert.match(enrollment, /sponsorApiRequest\('\/api\/sponsor\/status'\)/)
  assert.match(enrollment, /configuredSponsor === configuredOwner/)
  assert.match(enrollment, /authInitialPassword\.length < 12/)
  assert.match(enrollment, /authConfirmPassword !== authPassword/)
  assert.match(enrollment, /sponsorAuth\.enroll\(authPassword, '', authInitialPassword\)/)
  assert.match(enrollment, /session\?\.address !== configuredSponsor/)
  assert.match(enrollment, /setAuthInitialPassword\(''\)/)
  assert.match(enrollment, /setAuthConfirmPassword\(''\)/)
  assert.match(enrollment, /ownerAuth\.login\(authPassword, OWNER_ADMIN_LOGIN_EMAIL\)/)
  assert.match(enrollment, /sponsorAuth\.enroll\(authPassword, '', authInitialPassword\)/)
  assert.match(enrollment, /SPONSOR_ENROLLED_ADDRESS_MISMATCH/)
  assert.match(source, /saved === false \? <>[\s\S]*Existing Sponsor password/)
  assert.doesNotMatch(source, /One-time Sponsor enrollment token/)
  assert.match(source, /onClick=\{\(\) => void enrollSponsorWallet\(\)\}/)
  assert.match(source, /setSaved\(null\)/, 'status lookup failure must not be treated as proof that no account exists')
});
test('Sponsor pre-release checklist is distinct from live transaction execution readiness', () => {
  assert.ok(source.includes('<h3>Sponsor pre-release readiness review</h3>'))
  assert.ok(source.includes('Live Sponsor execution availability is reported separately above.'))
  assert.ok(source.includes('released ledger control, approved database identity, verified durability'))
  assert.equal(source.includes('paused-write and explicit Mainnet release gates'), false)
})
