import test from 'node:test'
import assert from 'node:assert/strict'
import { TronWeb } from 'tronweb'
import { assessTronAccountPermissions } from '../server/tron-account-permission-assessment.mjs'

const bytes=(types)=>{
  const result=new Uint8Array(32)
  for(const type of types) result[Math.floor(type/8)] |= 1 << (type%8)
  return Array.from(result).map((value)=>value.toString(16).padStart(2,'0')).join('')
}
const key=(id,weight=1)=>({address:TronWeb.address.fromHex('41'+String(id).padStart(40,'0')),weight})
const account=(ownerThreshold=2,activeThreshold=2,activeTypes=[1,30,31,46])=>({
  owner_permission:{threshold:ownerThreshold,keys:[key('1'.repeat(40)),key('2'.repeat(40))]},
  active_permission:[{
    id:2,permission_name:'restricted-transfer',threshold:activeThreshold,
    keys:[key('1'.repeat(40)),key('2'.repeat(40))],operations:bytes(activeTypes),
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

test('fails closed when duplicate addresses appear in a permission key list',()=>{
 const same=key('1'.repeat(40),1)
 const duplicateAccount={
  owner_permission:{threshold:2,keys:[same,{...same}]},
  active_permission:[{id:2,threshold:2,keys:[key('2'.repeat(40),1),key('3'.repeat(40),1)],operations:bytes([1,31,46])}],
 }
 assert.equal(assessTronAccountPermissions(duplicateAccount).available,false)
})

test('fails closed when any permission key is not a valid TRON address',()=>{
 const bad=account()
 bad.owner_permission.keys[0].address='not-an-address'
 assert.equal(assessTronAccountPermissions(bad).available,false)
})

test('flags single-key unfreeze and resource-control permissions as value relevant',()=>{
 const result=assessTronAccountPermissions(account(2,1,[12,13,55,56,57,58,59]))
 assert.equal(result.singleSignerCanMoveNativeTrx,true)
 assert.ok(result.activePermissions[0].enabledValueMovingOrPermissionTypes.includes(56))
})

test('fails closed when permission threshold exceeds total configured signer weight',()=>{
 const bad=account(3,2)
 assert.equal(assessTronAccountPermissions(bad).available,false)
})
test('fails closed when an active permission ID is outside the active permission range',()=>{
 const bad=account()
 bad.active_permission[0].id=46
 assert.equal(assessTronAccountPermissions(bad).available,false)
})
