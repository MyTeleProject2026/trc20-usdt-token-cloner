import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const workflow = await readFile(new URL('../src/WorkflowApp.tsx', import.meta.url), 'utf8')
const styles = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')
const authRoute = await readFile(new URL('../server/routes/tron-wallet-auth.mjs', import.meta.url), 'utf8')

test('the dashboard is gated behind a verified TronLink identity on first load', () => {
  assert.match(workflow, /const \[authChecking, setAuthChecking\] = useState\(true\)/)
  const gateIndex = workflow.indexOf('if (authChecking || !walletIdentity')
  const dashboardIndex = workflow.indexOf('const currentStep = STEPS[step]')
  assert.ok(gateIndex > -1 && dashboardIndex > gateIndex, 'login gate must render before the workflow dashboard')
  assert.match(workflow, /Sign in to your workspace/)
  assert.match(workflow, /Connect TronLink & sign in/)
  assert.match(workflow, /\/api\/auth\/tron\/session/)
  assert.match(workflow, /sessionStorage\.setItem\(AUTH_SESSION_STORAGE_KEY, identity\.sessionToken\)/)
  assert.match(authRoute, /authenticated: true/)
  assert.match(authRoute, /scope: 'wallet-identity-only'/)
  assert.match(styles, /\.studio-auth-screen/)
  assert.match(styles, /@media \(max-width:520px\)/)
})

test('account or network changes invalidate session and clear old account snapshots', () => {
  assert.match(workflow, /provider\.on\('accountsChanged', onAccountsChanged\)/)
  assert.match(workflow, /provider\.on\('chainChanged', onChainChanged\)/)
  assert.match(workflow, /const invalidateWalletSession = \(message: string, selectedAddress = ''\) =>/)
  assert.match(workflow, /invalidateWalletSession\(/)
  assert.match(workflow, /clearStoredAuthSession\(\)/)
  assert.match(workflow, /setWalletIdentity\(null\)/)
  assert.match(workflow, /setNativeSnapshot\(null\)/)
  assert.match(workflow, /setSenderTokenSnapshot\(null\)/)
  assert.match(workflow, /old balances are not reused/)
  assert.match(workflow, /TronLink account changed during sign-in/)
})

test('public-address entry is not accepted as authentication and private keys are never requested', () => {
  assert.match(workflow, /tronWeb\.trx\.signMessageV2\(challenge\.message\)/)
  assert.match(workflow, /Public address alone is not authentication/)
  assert.doesNotMatch(workflow, /privateKeyInput|private-key-input|seedPhraseInput|recoveryPhraseInput/i)
  assert.doesNotMatch(authRoute, /req\.body\.privateKey|body\.privateKey|privateKey:/i)
})
