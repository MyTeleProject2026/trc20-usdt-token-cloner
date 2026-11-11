import { buildSponsorGovernanceRegistryPins } from '../server/sponsor-governance-registry.mjs'

try {
  const pins = buildSponsorGovernanceRegistryPins(process.env)
  console.log(JSON.stringify({
    reviewerRegistryVersion: process.env.SPONSOR_ORG_REVIEWER_REGISTRY_VERSION || null,
    reviewerRegistrySha256: pins.reviewerDigest,
    reviewerCount: pins.reviewerCount,
    securityOfficerRegistryVersion: process.env.SPONSOR_ORG_SECURITY_OFFICERS_VERSION || null,
    securityOfficerRegistrySha256: pins.securityOfficerDigest,
    securityOfficerCount: pins.securityOfficerCount,
    note: 'Set the printed SHA-256 pins and explicit version strings in the secret manager. This script does not write configuration or expose wallet addresses.',
  }, null, 2))
} catch {
  console.error('Sponsor governance registry validation failed. Check the JSON schema, role coverage, duplicate addresses and independence rules.')
  process.exitCode = 1
}
