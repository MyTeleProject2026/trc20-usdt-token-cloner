import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyRestrictedTrxEscrowEvidence } from '../server/restricted-trx-escrow-verifier.mjs'

const beneficiary='TLBWTZHjjRMwbFgKgqmLwjp4ZKjxt5a2GT'
const contract='TXYZabcdefghijkmnopqrstuvwxyz1234567'
const contractHex='41'+'c'.repeat(40)
const txid='a'.repeat(64)
const evidence={
 expectedRequestId:'0x'+'b'.repeat(64),
 expectedBeneficiary:beneficiary,
 expectedContract:contract,
 expectedContractHex:contractHex,
 transaction:{txID:txid,raw_data:{contract:[{type:'TriggerSmartContract',parameter:{value:{contract_address:contractHex,call_value:2000000}}}]}},
 receipt:{id:txid,blockNumber:100,receipt:{result:'SUCCESS'}},
 position:{beneficiary,amountSun:'2000000',unlockAt:1900000000,claimed:false},
 contractBalanceSun:'5000000',
 totalLockedLiabilitiesSun:'4000000',
}

test('verifies successful solidified escrow evidence with sufficient collateral',()=>{
 const result=verifyRestrictedTrxEscrowEvidence(evidence)
 assert.equal(result.verified,true)
 assert.equal(result.creditableAmountSun,'2000000')
})
test('fails closed when transaction targets a different contract',()=>{\n assert.equal(verifyRestrictedTrxEscrowEvidence({...evidence,transaction:{...evidence.transaction,raw_data:{contract:[{type:'TriggerSmartContract',parameter:{value:{contract_address:'41'+'d'.repeat(40),call_value:2000000}}}]}}}).reason,'escrow-contract-mismatch')\n})\ntest('fails closed when collateral is below total locked liabilities',()=>{
 const result=verifyRestrictedTrxEscrowEvidence({...evidence,contractBalanceSun:'3000000'})
 assert.equal(result.verified,false)
 assert.equal(result.reason,'under-collateralized-escrow')
 assert.equal(result.creditableAmountSun,'0')
})
test('fails closed on wrong beneficiary or unsuccessful execution',()=>{
 assert.equal(verifyRestrictedTrxEscrowEvidence({...evidence,position:{...evidence.position,beneficiary:contract}}).reason,'beneficiary-mismatch')
 assert.equal(verifyRestrictedTrxEscrowEvidence({...evidence,receipt:{...evidence.receipt,receipt:{result:'REVERT'}}}).reason,'contract-execution-failed')
})
test('fails closed for missing receipt or unclaimed lock state',()=>{
 assert.equal(verifyRestrictedTrxEscrowEvidence({...evidence,receipt:null}).reason,'missing-solidified-evidence')
 assert.equal(verifyRestrictedTrxEscrowEvidence({...evidence,position:{...evidence.position,claimed:true}}).reason,'invalid-or-claimed-position')
})
