import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createRippleCustodyClient,
  getRippleCustodyConfigurationStatus,
  parseDecimalToSun,
  parseTrxToSun,
} from '../server/ripple-custody-client.mjs'

const env={
  RIPPLE_CUSTODY_ENV:'sandbox',
  RIPPLE_WALLETS_CLIENT_ID:'wallet-client',
  RIPPLE_WALLETS_CLIENT_SECRET:'wallet-secret',
  RIPPLE_TRANSACTIONS_CLIENT_ID:'tx-client',
  RIPPLE_TRANSACTIONS_CLIENT_SECRET:'tx-secret',
  RIPPLE_VAULT_ID:'vault-123',
  RIPPLE_WALLET_ID:'wallet-456',
  RIPPLE_TRON_SOURCE_ADDRESS:'TSourceAddress1111111111111111111111',
  RESTRICTED_TRX_BENEFICIARY_ADDRESS:'TRecipientAddress11111111111111111111',
}

function mockFetch(routes) {
 const calls=[]
 const fetchImpl=async (url,init={})=>{
  calls.push({url,init})
  const path=new URL(url).pathname
  if(path==='/v2/credentials/oauth/token') return {ok:true,status:200,json:async()=>({accessToken:'token'})}
  const item=routes[path]
  if(!item) return {ok:false,status:404,json:async()=>({message:'not-found'})}
  return {ok:true,status:200,json:async()=>item}
 }
 return {fetchImpl,calls}
}

test('Ripple config status never claims principal credit from API credentials',()=>{
 const status=getRippleCustodyConfigurationStatus(env)
 assert.equal(status.configured,true)
 assert.equal(status.creditFacilityVerified,false)
 assert.equal(status.principalCreditAvailableSun,null)
 assert.equal(status.liveTransferEnabled,false)
})

test('Ripple balance parser returns exact TRX available/total amounts from wallet balance',async()=>{
 const {fetchImpl,calls}=mockFetch({
  '/v2/vaults/vault-123/wallets/wallet-456/balances':{
   balances:[{asset:{symbol:'TRX',blockchain:'TRON',standard:'NATIVE',id:'1::TRX'},balance:'6200.250001',availableBalance:'6000.250001',pendingBalance:'100',frozenBalance:'100'}],
  },
 })
 const client=createRippleCustodyClient({env,fetchImpl})
 const result=await client.getWalletBalances()
 assert.equal(result.totalSun,'6200250001')
 assert.equal(result.availableSun,'6000250001')
 assert.equal(result.creditFacilityVerified,false)
 assert.match(calls[0].url,/\/v2\/credentials\/oauth\/token$/)
 assert.match(calls[1].url,/filter\.blockchain\.eq=TRON/)
})

test('Ripple fee estimator requests TRON native TRX fee for configured allowlisted recipient',async()=>{
 const {fetchImpl,calls}=mockFetch({
  '/v2/transactions/transfer/estimate-fee':{networkFees:{average:'0.25'}},
 })
 const client=createRippleCustodyClient({env,fetchImpl})
 const estimate=await client.estimateNativeTrxTransferFee()
 assert.equal(estimate.averageSun,'250000')
 assert.equal(JSON.parse(calls[1].init.body).symbol,'TRX')
 assert.equal(JSON.parse(calls[1].init.body).blockchain,'TRON')
})

test('Ripple refuses fee quote or transfer to an unapproved recipient',async()=>{
 const {fetchImpl}=mockFetch({'/v2/transactions/transfer/estimate-fee':{networkFees:{average:'0.25'}}})
 const client=createRippleCustodyClient({env,fetchImpl})
 await assert.rejects(client.estimateNativeTrxTransferFee({destinationAddress:'TAttackerAddress1111111111111111111'}),/destination-not-allowlisted/)
 await assert.rejects(client.createNativeTrxTransfer({
  amountTrx:'1',destinationAddress:'TAttackerAddress1111111111111111111',networkFeeTrx:'0.1',
 }),/ripple-live-transfer-disabled/)
})

test('Ripple live transfer remains hard disabled without internal authorization',async()=>{
 const {fetchImpl,calls}=mockFetch({
  '/v2/vaults/vault-123/wallets/wallet-456/transactions/transfer':{id:'tx-12345678',status:'REQUESTED'},
 })
 const client=createRippleCustodyClient({env,fetchImpl})
 await assert.rejects(client.createNativeTrxTransfer({
  amountTrx:'1',networkFeeTrx:'0.1',
  fundingAuthorization:{
   provider:'ripple',status:'approved',signatureVerified:true,
   agreementReference:'agreement',authorizationId:'auth',
   expiresAt:'2099-01-01T00:00:00.000Z',
   availablePrincipalSun:'10000000',creditLimitSun:'10000000',feeBudgetSun:'1000000',
  },
 }),error=>error.status===423 && /live-transfer-disabled/.test(error.message))
 assert.equal(calls.some(call=>call.url.includes('/transactions/transfer') && call.init.method==='POST'),false)
})

test('amount conversion rejects zero, negatives, exponent notation, and more than six decimals',()=>{
 assert.equal(parseDecimalToSun('6200.25'),'6200250000')
 assert.equal(parseTrxToSun('0.000001'),1n)
 for(const invalid of ['0','-1','1e3','1.0000001','NaN']) assert.throws(()=>parseTrxToSun(invalid))
})
