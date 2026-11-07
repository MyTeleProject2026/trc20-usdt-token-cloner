import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  buildSponsorGovernanceRegistryPins, getSponsorReviewerRegistry, getSponsorSecurityOfficerRegistry,
} from '../server/sponsor-governance-registry.mjs'

const reviewerA='T'+'1'.repeat(33)
const reviewerB='T'+'2'.repeat(33)
const officer='T'+'3'.repeat(33)

function envWithRegistries() {
  const env={
    SPONSOR_ORG_REVIEWER_REGISTRY:JSON.stringify([
      {walletAddress:reviewerA,role:'compliance-reviewer',active:true},
      {walletAddress:reviewerB,role:'security-reviewer',active:true},
    ]),
    SPONSOR_ORG_SECURITY_OFFICERS:JSON.stringify([{walletAddress:officer,active:true}]),
    SPONSOR_ORG_REVIEWER_REGISTRY_VERSION:'reviewers-v1',
    SPONSOR_ORG_SECURITY_OFFICERS_VERSION:'security-v1',
  }
  const pins=buildSponsorGovernanceRegistryPins(env)
  env.SPONSOR_ORG_REVIEWER_REGISTRY_SHA256=pins.reviewerDigest
  env.SPONSOR_ORG_SECURITY_OFFICERS_SHA256=pins.securityOfficerDigest
  return env
}

test('reviewer and security registries require valid versioned digest pins and independent addresses',()=>{
  const env=envWithRegistries()
  assert.equal(getSponsorReviewerRegistry(env).configured,true)
  assert.equal(getSponsorSecurityOfficerRegistry(env).configured,true)
  assert.equal(getSponsorReviewerRegistry({...env,SPONSOR_ORG_REVIEWER_REGISTRY_SHA256:'0'.repeat(64)}).reason,'registry-digest-pin-mismatch')
  assert.equal(getSponsorReviewerRegistry({...env,SPONSOR_ORG_REVIEWER_REGISTRY_VERSION:''}).configured,false)
})

test('registry validation rejects missing role quorum, duplicate addresses and overlapping security officers',()=>{
  const env=envWithRegistries()
  const oneRole={...env,SPONSOR_ORG_REVIEWER_REGISTRY:JSON.stringify([{walletAddress:reviewerA,role:'compliance-reviewer',active:true},{walletAddress:reviewerB,role:'compliance-reviewer',active:true}])}
  assert.equal(buildSponsorGovernanceRegistryPins(oneRole).reviewerCount,1)
  oneRole.SPONSOR_ORG_REVIEWER_REGISTRY_SHA256=createHash('sha256').update(JSON.stringify([{walletAddress:reviewerA,role:'compliance-reviewer',active:true},{walletAddress:reviewerB,role:'compliance-reviewer',active:true}])).digest('hex')
  assert.equal(getSponsorReviewerRegistry(oneRole).reason,'reviewer-role-quorum-not-configured')
  const duplicate={...env,SPONSOR_ORG_REVIEWER_REGISTRY:JSON.stringify([
    {walletAddress:reviewerA,role:'compliance-reviewer',active:true},
    {walletAddress:reviewerA,role:'security-reviewer',active:true},
  ])}
  assert.equal(getSponsorReviewerRegistry(duplicate).reason,'registry-wallet-duplicate')
  const overlap={...env,SPONSOR_ORG_SECURITY_OFFICERS:JSON.stringify([{walletAddress:reviewerA,active:true}])}
  const overlapPins=buildSponsorGovernanceRegistryPins(overlap)
  overlap.SPONSOR_ORG_SECURITY_OFFICERS_SHA256=overlapPins.securityOfficerDigest
  assert.equal(getSponsorSecurityOfficerRegistry(overlap).reason,'security-officer-must-be-independent-of-reviewers')
})
