import test from 'node:test'
import assert from 'node:assert/strict'
import { TronWeb } from 'tronweb'
import { verifyRestrictedTrxEscrowEvidence } from '../server/restricted-trx-escrow-verifier.mjs'

const beneficiary='TLBWTZHjjRMwbFgKgqmLwjp4ZKjxt5a2GT'
const provider=beneficiary
const beneficiaryHex=TronWeb.address.toHex(beneficiary).replace(/^41/i,'').toLowerCase()
const escrowHex='41'+'c'.repeat(40)
const escrow=TronWeb.address.fromHex(escrowHex)
const txid='a'.repeat(64)
const requestId='b'.repeat(64)
const amountSun=6200000000n
const unlockAt=1900000000n
const addressWord='0'.repeat(24)+beneficiaryHex
const word=(value)=>BigInt(value).toString(16).padStart(64,'0')
const selector=TronWeb.sha3('fundPosition(bytes32,address,uint64)').slice(2,10).toLowerCase()
const eventTopic=TronWeb.sha3('PositionFunded(bytes32,address,uint256,uint64)').toLowerCase()

const evidence={
 expectedRequestId:'0x'+requestId,
 expectedBeneficiary:beneficiary,
 expectedContract:escrow,
 expectedProvider:provider,
 transaction:{
  txID:txid,
  raw_data:{contract:[{
   type:'TriggerSmartContract',
   parameter:{value:{
    contract_address:escrowHex,
    owner_address:TronWeb.address.toHex(provider),
    call_value:amountSun.toString(),
    data:selector+requestId+addressWord+word(3600),
   }},
  }]},
 },
 receipt:{
  id:txid, blockNumber:100,
  receipt:{result:'SUCCESS'},
  log:[{
   address:escrowHex,
   topics:[eventTopic,'0x'+requestId,'0x'+addressWord],
   data:word(amountSun)+word(unlockAt),
  }],
 },
 position:{beneficiary,amountSun:amountSun.toString(),unlockAt:unlockAt.toString(),claimed:false},
 contractBalanceSun:'7000000000',
 totalLockedLiabilitiesSun:'6200000000',
}

test('verifies solidified transaction, exact calldata, event, position, and collateral',()=>{
 const result=verifyRestrictedTrxEscrowEvidence(evidence)
 assert.equal(result.verified,true)
 assert.equal(result.amountSun,amountSun.toString())
 assert.equal(result.creditableAmountSun,amountSun.toString())
 assert.equal(result.requestId,'0x'+requestId)
 assert.equal(result.beneficiary,beneficiary)
})

test('fails closed if transaction targets another contract',()=>{
 const bad={...evidence,transaction:{...evidence.transaction,raw_data:{contract:[{
  ...evidence.transaction.raw_data.contract[0],
  parameter:{value:{...evidence.transaction.raw_data.contract[0].parameter.value,contract_address:'41'+'d'.repeat(40)}},
 }]}}}
 assert.equal(verifyRestrictedTrxEscrowEvidence(bad).reason,'escrow-contract-mismatch')
})

test('fails closed if call data request ID or beneficiary differs',()=>{
 const call=evidence.transaction.raw_data.contract[0].parameter.value
 const badId={...evidence,transaction:{...evidence.transaction,raw_data:{contract:[{
  ...evidence.transaction.raw_data.contract[0],parameter:{value:{...call,data:selector+'f'.repeat(64)+addressWord+word(3600)}},
 }]}}}
 assert.equal(verifyRestrictedTrxEscrowEvidence(badId).reason,'request-id-calldata-mismatch')
 const badBeneficiary={...evidence,transaction:{...evidence.transaction,raw_data:{contract:[{
  ...evidence.transaction.raw_data.contract[0],parameter:{value:{...call,data:selector+requestId+'0'.repeat(64)+word(3600)}},
 }]}}}
 assert.equal(verifyRestrictedTrxEscrowEvidence(badBeneficiary).reason,'beneficiary-calldata-mismatch')
})

test('fails closed when the funding sender is not the provider',()=>{
 const call=evidence.transaction.raw_data.contract[0].parameter.value
 const bad={...evidence,transaction:{...evidence.transaction,raw_data:{contract:[{
  ...evidence.transaction.raw_data.contract[0],parameter:{value:{...call,owner_address:escrowHex}},
 }]}}}
 assert.equal(verifyRestrictedTrxEscrowEvidence(bad).reason,'provider-sender-mismatch')
})

test('fails closed if event, tx call value, and stored position amount differ',()=>{
 const badEvent={...evidence,receipt:{...evidence.receipt,log:[{...evidence.receipt.log[0],data:word(amountSun+1n)+word(unlockAt)}]}}
 assert.equal(verifyRestrictedTrxEscrowEvidence(badEvent).reason,'principal-amount-mismatch')
 const call=evidence.transaction.raw_data.contract[0].parameter.value
 const badCall={...evidence,transaction:{...evidence.transaction,raw_data:{contract:[{
  ...evidence.transaction.raw_data.contract[0],parameter:{value:{...call,call_value:String(amountSun+1n)}},
 }]}}}
 assert.equal(verifyRestrictedTrxEscrowEvidence(badCall).reason,'principal-amount-mismatch')
})

test('fails closed for unconfirmed, reverted, wrong-beneficiary, or claimed positions',()=>{
 assert.equal(verifyRestrictedTrxEscrowEvidence({...evidence,receipt:{...evidence.receipt,blockNumber:0}}).reason,'transaction-not-solidified')
 assert.equal(verifyRestrictedTrxEscrowEvidence({...evidence,receipt:{...evidence.receipt,receipt:{result:'REVERT'}}}).reason,'contract-execution-failed')
 assert.equal(verifyRestrictedTrxEscrowEvidence({...evidence,position:{...evidence.position,beneficiary:escrow}}).reason,'beneficiary-mismatch')
 assert.equal(verifyRestrictedTrxEscrowEvidence({...evidence,position:{...evidence.position,claimed:true}}).reason,'invalid-or-claimed-position')
})

test('fails closed when contract liabilities exceed its actual TRX balance',()=>{
 const result=verifyRestrictedTrxEscrowEvidence({...evidence,contractBalanceSun:'6000000000'})
 assert.equal(result.verified,false)
 assert.equal(result.reason,'under-collateralized-escrow')
 assert.equal(result.creditableAmountSun,'0')
})

test('fails closed when funding event is absent or request IDs do not match',()=>{
 assert.equal(verifyRestrictedTrxEscrowEvidence({...evidence,receipt:{...evidence.receipt,log:[]}}).reason,'position-funded-event-not-found')
 assert.equal(verifyRestrictedTrxEscrowEvidence({...evidence,expectedRequestId:'0x'+'e'.repeat(64)}).reason,'request-id-calldata-mismatch')
})

test('fails closed when the solidified transaction body does not match the requested txid',()=>{
 assert.equal(verifyRestrictedTrxEscrowEvidence({...evidence,expectedTxId:'f'.repeat(64)}).reason,'requested-transaction-id-mismatch')
})
