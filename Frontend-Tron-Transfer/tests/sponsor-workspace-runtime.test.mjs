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


test('Sponsor security-event callback is initialized before the auto-restore effect reads it', () => {
  const callback = source.indexOf('const recordSecurityEvent = useCallback(')
  const restoreEffect = source.indexOf('// Restore the paired Sponsor role')
  const dependency = source.indexOf('recordSecurityEvent])', restoreEffect)
  assert.notEqual(callback, -1, 'security-event callback must remain memoized')
  assert.notEqual(restoreEffect, -1, 'paired Sponsor auto-restore effect must exist')
  assert.notEqual(dependency, -1, 'auto-restore effect must retain its callback dependency')
  assert.ok(callback < restoreEffect && restoreEffect < dependency, 'the callback must be initialized before the effect callback and dependency array are evaluated')
})

test('Sponsor Owner Admin CSRF state is declared before session restoration uses its setter', () => {
  assert.match(source, /const \[ownerAdminCsrfToken, setOwnerAdminCsrfToken\] = useState\(''\)/)
  assert.match(source, /setOwnerAdminCsrfToken\(ownerSession\.csrfToken \|\| ''\)/)
  assert.match(source, /ownerAdminCsrfToken/)
})

test('Sponsor render boundary exposes a component trace and a full-application recovery action', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
  assert.match(app, /componentStack: ''/)
  assert.match(app, /String\(info\?\.componentStack \|\| ''\)/)
  assert.match(app, /Show component trace for support/)
  assert.match(app, /window\.location\.reload\(\)/)
  assert.match(app, /componentStack: ''/)
})


test('Sponsor auto-restore callback is initialized before the effect and its dependency list', () => {
  const callback = source.indexOf('const recordSecurityEvent = useCallback(')
  const restoreMarker = source.indexOf('// Restore the paired Sponsor role')
  const restoreEffect = source.indexOf('useEffect(() => {', restoreMarker)
  const restoreDependencies = source.indexOf('[sharedOwnerPassword, vaultSaved, wallet, ownerAuth, sponsorAuth, notify, recordSecurityEvent]', restoreEffect)
  assert.ok(callback >= 0 && restoreMarker > callback, 'recordSecurityEvent must be initialized before the auto-restore effect')
  assert.ok(restoreEffect > restoreMarker && restoreDependencies > restoreEffect, 'the paired-session restoration effect and dependency list must remain present')
})

test('Owner shell and Sponsor component share the graphite-and-gold exchange design tokens', async () => {
  const ownerTheme = await readFile(new URL('../src/owner-admin-redesign.css', import.meta.url), 'utf8')
  const sponsorTheme = await readFile(new URL('../src/sponsor-wallet.css', import.meta.url), 'utf8')
  assert.match(ownerTheme, /--owner-bg:\s*#090a0c/)
  assert.match(ownerTheme, /--owner-primary:\s*#d7b15e/)
  assert.match(ownerTheme, /\.trax-mobile-nav[\s\S]*background:rgba\(12,13,15/)
  assert.match(sponsorTheme, /\.sponsor-card[\s\S]*background:linear-gradient\(145deg,rgba\(25,27,30/)
  assert.match(sponsorTheme, /\.sponsor-primary[\s\S]*#e2c16f/)
})


test('Sponsor render boundary exposes the JavaScript stack as well as the React component trace', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
  assert.match(app, /errorStack: ''/)
  assert.match(app, /String\(error\?\.stack \|\| ''\)/)
  assert.match(app, /Show Sponsor JavaScript stack for support/)
  assert.match(app, /this\.state\.errorStack/)
})


test('Owner and Sponsor error boundaries retain actionable component and JavaScript stacks and clear them on retry', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
  for (const role of ['Owner', 'Sponsor']) {
    assert.ok(app.includes(`Show ${role} component trace for support`), role + ' component trace must be visible')
    assert.ok(app.includes(`Show ${role} JavaScript stack for support`), role + ' JavaScript stack must be visible')
  }
  assert.match(app, /errorStack: String\(error\?\.stack \|\| ''\)/)
  assert.match(app, /componentStack: '', errorStack: ''/)
  assert.match(app, /hasError: false, message: '', componentStack: '', errorStack: ''/)
})


test('Owner TRX and USDT withdrawals use guided recipient/amount stages and open detailed operation receipts', async () => {
  const panel = await readFile(new URL('../src/TRXMainnetPanel.jsx', import.meta.url), 'utf8')
  const theme = await readFile(new URL('../src/owner-admin-redesign.css', import.meta.url), 'utf8')
  assert.match(panel, /const \[trxWithdrawalStep, setTrxWithdrawalStep\] = useState\(1\)/)
  assert.match(panel, /const \[usdtWithdrawalStep, setUsdtWithdrawalStep\] = useState\(1\)/)
  assert.match(panel, /Continue to withdrawal amount/)
  assert.match(panel, /Review native TRX withdrawal/)
  assert.match(panel, /Review official USDT withdrawal/)
  assert.match(panel, /setSelectedWithdrawalReceipt\(\{ \.\.\.item, asset: 'TRX' \}\)/)
  assert.match(panel, /setSelectedWithdrawalReceipt\(\{ \.\.\.item, asset: 'USDT' \}\)/)
  assert.match(panel, /aria-label="Review Owner Mainnet operation"/)
  assert.match(panel, /solidified Mainnet receipt has been verified/)
  assert.match(theme, /\.trax-receipt-backdrop/)
  assert.match(theme, /\.trax-receipt-sheet/)
})
