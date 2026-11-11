import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeNileNodeUrl, runSponsorGovernanceTestnetCheck } from '../scripts/run-sponsor-governance-testnet-check.mjs'

test('testnet verification accepts only the HTTPS Nile node origin',()=>{
  assert.equal(normalizeNileNodeUrl('https://nile.trongrid.io'),'https://nile.trongrid.io')
  assert.throws(()=>normalizeNileNodeUrl('https://api.trongrid.io'),/exact HTTPS Nile/)
  assert.throws(()=>normalizeNileNodeUrl('https://nile.trongrid.io.attacker.test'),/exact HTTPS Nile/)
  assert.throws(()=>normalizeNileNodeUrl('http://nile.trongrid.io'),/exact HTTPS Nile/)
})

test('testnet verification performs a read-only Nile block request only',async()=>{
  let request
  const report=await runSponsorGovernanceTestnetCheck({
    nodeUrl:'https://nile.trongrid.io',
    fetchImpl:async(url,options)=>{
      request={url:String(url),options}
      return new Response(JSON.stringify({block_header:{raw_data:{number:123456}}}),{status:200})
    },
  })
  assert.equal(request.options.method,'GET')
  assert.equal(request.url,'https://nile.trongrid.io/wallet/getnowblock')
  assert.equal(report.network,'nile')
  assert.equal(report.latestBlockHeight,123456)
  assert.equal(report.mainnetContacted,false)
  assert.equal(report.transactionSigned,false)
  assert.equal(report.transactionBroadcast,false)
  assert.equal(report.realPayoutExecutionEnabled,false)
})
