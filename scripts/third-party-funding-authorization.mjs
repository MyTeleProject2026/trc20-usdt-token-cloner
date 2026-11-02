import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import {
  buildThirdPartyFundingAuthorizationMessage,
  verifyThirdPartyFundingAuthorization,
} from '../src/third-party-funding-authorization.mjs'

const MAX_MANIFEST_BYTES = 32 * 1024

async function loadManifest(filePath) {
  if (!filePath) throw new TypeError('Provide a JSON manifest path')
  const raw = await readFile(filePath)
  if (raw.length > MAX_MANIFEST_BYTES) throw new TypeError('Authorization manifest exceeds 32 KiB')
  return JSON.parse(raw.toString('utf8'))
}

export async function runThirdPartyFundingAuthorizationCli(args = process.argv.slice(2), env = process.env) {
  const [command, manifestPath] = args
  if (!['message', 'verify'].includes(command)) {
    throw new TypeError('Usage: node scripts/third-party-funding-authorization.mjs <message|verify> <manifest.json>')
  }
  const manifest = await loadManifest(manifestPath)
  const expectedVaultAddress = typeof env.TREASURY_ADDRESS === 'string' ? env.TREASURY_ADDRESS.trim() : ''
  const expectedSponsorOrganizationReference = typeof env.TREASURY_SPONSOR_ORGANIZATION_REFERENCE === 'string'
    ? env.TREASURY_SPONSOR_ORGANIZATION_REFERENCE.trim() : ''
  const expectedAgreementReference = typeof env.TREASURY_SPONSOR_AGREEMENT_REFERENCE === 'string'
    ? env.TREASURY_SPONSOR_AGREEMENT_REFERENCE.trim() : ''
  if (!expectedSponsorOrganizationReference || !expectedAgreementReference
    || manifest?.sponsorOrganizationReference !== expectedSponsorOrganizationReference
    || manifest?.agreementReference !== expectedAgreementReference) {
    process.stdout.write(JSON.stringify({
      success: false,
      verified: false,
      reason: 'manifest-sponsor-organization-or-agreement-does-not-match-outgoing-policy',
      payoutExecutionAuthorized: false,
    }, null, 2) + '\n')
    return { success: false, verified: false }
  }
  if (!expectedVaultAddress || manifest?.vaultAddress !== expectedVaultAddress) {
    process.stdout.write(JSON.stringify({
      success: false,
      verified: false,
      reason: !expectedVaultAddress
        ? 'TREASURY_ADDRESS-must-be-set-to-the-real-Fireblocks-vault-address'
        : 'manifest-vault-does-not-match-configured-TREASURY_ADDRESS',
      payoutExecutionAuthorized: false,
    }, null, 2) + '\n')
    return { success: false, verified: false }
  }

  if (command === 'message') {
    process.stdout.write(buildThirdPartyFundingAuthorizationMessage(manifest) + '\n')
    return { success: true, command: 'message' }
  }

  const result = await verifyThirdPartyFundingAuthorization(manifest, { expectedVaultAddress, expectedSponsorOrganizationReference, expectedAgreementReference })
  process.stdout.write(JSON.stringify({
    success: result.verified === true,
    verified: result.verified === true,
    reason: result.reason ?? null,
    authorization: result.authorization ?? null,
    payoutExecutionAuthorized: false,
    note: 'This verifies a scoped incoming-deposit message signature only. It does not verify legal authority, prove funds were deposited, or authorize subsequent payouts.',
  }, null, 2) + '\n')
  return { success: result.verified === true, verified: result.verified === true }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === invokedPath) {
  runThirdPartyFundingAuthorizationCli().then((result) => {
    if (!result.success) process.exitCode = 1
  }).catch((error) => {
    process.stderr.write((error instanceof SyntaxError ? 'Invalid JSON authorization manifest.' : error.message || 'Authorization check failed.') + '\n')
    process.exitCode = 1
  })
}
