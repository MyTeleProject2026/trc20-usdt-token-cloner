import test from 'node:test'
import assert from 'node:assert/strict'
import { assessTronAccountPermissions } from '../server/tron-account-permission-assessment.mjs'

const bytes=(types)=>{
  const result=new Uint8Array(32)
  for(const type of types) result[Math.floor(type/8)] |= 1 << (type%8)
  return Array.from(result).map((value)=>value.toString(16).padStart(2,'0')).join('')
}
const key=(address,weight=1)=>({address,weight})
const account=(ownerThreshold=2,activeThreshold=2,activeTypes=[1,30,31,46])=>({
  owner_permission:{threshold:ownerThreshold,keys:[key('TRecipientKey'),key('TProviderKey')]},
  active_permission:[{
    id:2,permission_name:'restricted-transfer',threshold:activeThreshold,
    keys:[key('TRecipientKey'),key('TProviderKey')],operations:bytes(activeTypes),
  }],
})

test('recognizes a 2-of-2 account permission set that prevents any one key moving TRX',()=>{
  const result=assessTronAccountPermissions(account())
  assert.equal(result.available,true)
  assert.equal(result.multiSignatureConfigured,true)
  assert.equal(result.singleSignerCanMoveNativeTrx,false)
  assert.equal(result.restrictedAgainstSingleKey,true)
})
test('detects a single-key owner permission even if active permission is 2-of-2',()=>{
  const result=assessTronAccountPermissions(account(1,2))
  assert.equal(result.singleSignerCanMoveNativeTrx,true)
  assert.equal(result.restrictedAgainstSingleKey,false)
})
test('detects a single-key active permission that enables direct transfers',()=>{
  const result=assessTronAccountPermissions(account(2,1))
  assert.equal(result.singleSignerCanMoveNativeTrx,true)
})
test('ignores active permissions that cannot move value or change permissions',()=>{
  const result=assessTronAccountPermissions(account(2,1,[4,54,55]))
  assert.equal(result.singleSignerCanMoveNativeTrx,false)
  assert.equal(result.restrictedAgainstSingleKey,true)
})
test('fails closed when permission data is missing or malformed',()=>{
  assert.equal(assessTronAccountPermissions({}).available,false)
  const bad=account()
  bad.active_permission[0].operations='02'
  assert.equal(assessTronAccountPermissions(bad).available,false)
})
