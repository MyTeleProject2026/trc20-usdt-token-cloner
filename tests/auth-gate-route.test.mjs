import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const entry = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8')
const gate = await readFile(new URL('../src/AuthGate.tsx', import.meta.url), 'utf8')
const server = await readFile(new URL('../server/index.mjs', import.meta.url), 'utf8')
const authRoute = await readFile(new URL('../server/routes/tron-wallet-auth.mjs', import.meta.url), 'utf8')

test('every application route is wrapped in the same single-owner authentication gate', () => {
  assert.match(entry, /import AuthGate from '\.\/AuthGate\.tsx'/)
  assert.match(entry, /<AuthGate>\{page\}<\/AuthGate>/)
  assert.match(server, /app\.use\('\/api\/auth\/owner', createOwnerAuthRouter\(\)\)/)
  assert.match(gate, /\/api\/auth\/owner\/login/)
  assert.match(gate, /\/api\/auth\/owner\/session/)
  assert.match(gate, /\/api\/auth\/owner\/logout/)
  assert.match(gate, /OWNER AUTHENTICATION/)
  assert.match(gate, /Owner TRON address/)
  assert.match(gate, /Owner password/)
  assert.match(gate, /There is no public sign-up or account creation/)
})

test('owner authentication is allowlisted, password-hashed, short-lived and fail-closed', () => {
  assert.match(authRoute, /OWNER_WALLET_ADDRESS/)
  assert.match(authRoute, /OWNER_PASSWORD_HASH/)
  assert.match(authRoute, /scrypt/)
  assert.match(authRoute, /OWNER_LOGIN_MAX_ATTEMPTS/)
  assert.match(authRoute, /single-owner-console/)
  assert.match(authRoute, /owner-auth-not-configured/)
  assert.match(authRoute, /store\.revokeSession/)
})

test('the default route opens the wallet vault and the legacy workflow URL no longer exposes the old wizard', () => {
  assert.match(entry, /: <WalletVault \/>/)
  assert.match(entry, /isLegacyWorkspace \|\| isSponsorOperator/)
})
