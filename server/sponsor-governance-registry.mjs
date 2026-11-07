import { createHash } from 'node:crypto'
import { isValidTronAddress } from './tron-address.mjs'

const REVIEW_ROLES = new Set(['compliance-reviewer','security-reviewer'])

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
function canonical(entries, includeRole) {
  const normalized = entries.map((entry) => includeRole
    ? { walletAddress:entry.walletAddress, role:entry.role, active:true }
    : { walletAddress:entry.walletAddress, active:true })
    .sort((a,b) => a.walletAddress.localeCompare(b.walletAddress))
  return JSON.stringify(normalized)
}
function parseEntries(raw, kind) {
  let parsed
  try { parsed = JSON.parse(typeof raw === 'string' ? raw : '') } catch { return { entries:[], reason:'registry-json-invalid' } }
  if (!Array.isArray(parsed) || parsed.length < (kind === 'reviewer' ? 2 : 1) || parsed.length > 20) {
    return { entries:[], reason:'registry-entry-count-invalid' }
  }
  const entries = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some((key) => !['walletAddress','role','active'].includes(key))
      || !isValidTronAddress(item.walletAddress) || item.active !== true
      || (kind === 'reviewer' && !REVIEW_ROLES.has(item.role))
      || (kind === 'security' && item.role !== undefined)) {
      return { entries:[], reason:'registry-entry-invalid' }
    }
    entries.push(kind === 'reviewer'
      ? { walletAddress:item.walletAddress, role:item.role, active:true }
      : { walletAddress:item.walletAddress, active:true })
  }
  if (new Set(entries.map((entry) => entry.walletAddress)).size !== entries.length) {
    return { entries:[], reason:'registry-wallet-duplicate' }
  }
  if (kind === 'reviewer') {
    const roles = new Set(entries.map((entry) => entry.role))
    if (!roles.has('compliance-reviewer') || !roles.has('security-reviewer')) {
      return { entries:[], reason:'reviewer-role-quorum-not-configured' }
    }
  }
  return { entries, reason:null }
}
function checkRegistry(env, kind) {
  const reviewer = kind === 'reviewer'
  const raw = env[reviewer ? 'SPONSOR_ORG_REVIEWER_REGISTRY' : 'SPONSOR_ORG_SECURITY_OFFICERS']
  const version = String(env[reviewer ? 'SPONSOR_ORG_REVIEWER_REGISTRY_VERSION' : 'SPONSOR_ORG_SECURITY_OFFICERS_VERSION'] || '').trim()
  const expected = String(env[reviewer ? 'SPONSOR_ORG_REVIEWER_REGISTRY_SHA256' : 'SPONSOR_ORG_SECURITY_OFFICERS_SHA256'] || '').trim().toLowerCase()
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(version) || !/^[a-f0-9]{64}$/.test(expected)) {
    return { configured:false, entries:[], version:null, reason:'registry-version-or-digest-pin-missing' }
  }
  const parsed = parseEntries(raw, kind)
  if (parsed.reason) return { configured:false, entries:[], version, reason:parsed.reason }
  const actual = digest(canonical(parsed.entries, reviewer))
  if (actual !== expected) return { configured:false, entries:[], version, reason:'registry-digest-pin-mismatch' }
  return { configured:true, entries:parsed.entries, version, digest:actual, reason:null }
}

export function getSponsorReviewerRegistry(env = process.env) {
  return checkRegistry(env, 'reviewer')
}
export function getSponsorSecurityOfficerRegistry(env = process.env) {
  const result = checkRegistry(env, 'security')
  if (!result.configured) return result
  const reviewers = getSponsorReviewerRegistry(env)
  if (!reviewers.configured || result.entries.some((entry) => reviewers.entries.some((reviewer) => reviewer.walletAddress === entry.walletAddress))) {
    return { configured:false, entries:[], version:result.version, reason:'security-officer-must-be-independent-of-reviewers' }
  }
  return result
}
export function buildSponsorGovernanceRegistryPins(env = process.env) {
  const reviewers = parseEntries(env.SPONSOR_ORG_REVIEWER_REGISTRY, 'reviewer')
  const officers = parseEntries(env.SPONSOR_ORG_SECURITY_OFFICERS, 'security')
  if (reviewers.reason) throw new Error('reviewer-' + reviewers.reason)
  if (officers.reason) throw new Error('security-' + officers.reason)
  if (officers.entries.some((entry) => reviewers.entries.some((reviewer) => reviewer.walletAddress === entry.walletAddress))) {
    throw new Error('security-officer-must-be-independent-of-reviewers')
  }
  return {
    reviewerDigest: digest(canonical(reviewers.entries, true)),
    securityOfficerDigest: digest(canonical(officers.entries, false)),
    reviewerCount: reviewers.entries.length,
    securityOfficerCount: officers.entries.length,
  }
}
