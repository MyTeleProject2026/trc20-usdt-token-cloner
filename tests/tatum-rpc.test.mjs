import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createTatumRpcRouter } from '../server/routes/tatum-rpc.mjs'

function fakeResponse(status, payload) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) }
}
function responseRecorder() {
  return {
    code: 200, body: null, headers: {},
    setHeader(k,v){ this.headers[k]=v; return this },
    status(v){ this.code=v; return this },
    json(v){ this.body=v; return this },
  }
}
async function invoke(router, { network='mainnet', group='wallet', method='getaccount', body={address:'T123'}, env={TATUM_API_KEY:'test-key'}, fetchImpl=async()=>fakeResponse(200,{result:{}}), ip='127.0.0.1' }={}) {
  const req={params:{network,group,method},body,ip}
  const res=responseRecorder()
  const layer=router.stack.find(x=>x.route?.path==='/rpc/:network/:group/:method')
  await layer.route.stack[0].handle(req,res)
  return res
}

test('Tatum RPC proxy requires a server-side API key and never returns it',async()=>{
  const router=createTatumRpcRouter({env:{},fetchImpl:async()=>{throw new Error('must not call')}})
  const response=await invoke(router,{env:{}})
  assert.equal(response.code,503)
  assert.equal(response.body.error,'tatum-api-key-missing')
})

test('Tatum RPC proxy forwards only approved network methods with server-side credentials',async()=>{
  const calls=[]
  const router=createTatumRpcRouter({env:{TATUM_API_KEY:'server-secret'},fetchImpl:async(url,init)=>{calls.push({url,init});return fakeResponse(200,{result:{value:1}})}})
  const response=await invoke(router,{body:{address:'Ttest'}})
  assert.equal(response.code,200)
  assert.equal(calls[0].url,'https://tron-mainnet.gateway.tatum.io/wallet/getaccount')
  assert.equal(calls[0].init.headers['x-api-key'],'server-secret')
  assert.equal(response.body.result.value,1)
})

test('Tatum RPC proxy rejects unapproved methods and networks',async()=>{
  let calls=0
  const router=createTatumRpcRouter({env:{TATUM_API_KEY:'key'},fetchImpl:async()=>{calls++;return fakeResponse(200,{})}})
  assert.equal((await invoke(router,{method:'deleteaccount'})).code,404)
  assert.equal((await invoke(router,{network:'unsupported'})).code,404)
  assert.equal(calls,0)
})

test('Tatum broadcast proxy requires a signed, unexpired transaction with matching txID',async()=>{
  const raw='{"expiration":2000000000500}'
  const rawHex=Buffer.from(raw).toString('hex')
  const txID=createHash('sha256').update(Buffer.from(rawHex,'hex')).digest('hex')
  let calls=0
  const router=createTatumRpcRouter({env:{TATUM_API_KEY:'key'},now:()=>2_000_000_000_000,fetchImpl:async()=>{calls++;return fakeResponse(200,{result:{result:true}})}})
  const bad=await invoke(router,{method:'broadcasttransaction',body:{txID,raw_data:{expiration:2000000000500},raw_data_hex:rawHex,signature:[]}})
  assert.equal(bad.code,400)
  assert.equal(calls,0)
  const good=await invoke(router,{method:'broadcasttransaction',body:{txID,raw_data:{expiration:2000000000500},raw_data_hex:rawHex,signature:['a'.repeat(130)]}})
  assert.equal(good.code,200)
  assert.equal(calls,1)
})

test('Tatum RPC proxy applies an IP-scoped request limit',async()=>{
  let calls=0
  const router=createTatumRpcRouter({env:{TATUM_API_KEY:'key'},rateLimit:1,fetchImpl:async()=>{calls++;return fakeResponse(200,{})}})
  assert.equal((await invoke(router)).code,200)
  assert.equal((await invoke(router)).code,429)
  assert.equal(calls,1)
})
