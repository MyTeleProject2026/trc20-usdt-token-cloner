import test from 'node:test'; import assert from 'node:assert/strict';
import { createFystackReadOnlyAdapter, normalizeFystackUsdtSnapshot } from '../server/fystack-readonly-adapter.mjs';
const valid=()=>({authenticated:true,workspaceId:'ws_12345678',walletId:'wal_12345678',walletAddress:'TU3kjFuhtEo42tsCBtfYUAZxoqQ4yuSLQ5',network:'TRON_MAINNET',tokenContract:'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',decimals:6,balanceKind:'available',availableBalanceBaseUnits:'0',checkedAt:new Date().toISOString()});
test('normalizes complete fresh available official-mainnet USDT snapshot',()=>{const r=normalizeFystackUsdtSnapshot(valid());assert.equal(r.snapshot.balanceBaseUnits,'0');assert.equal(r.snapshot.balanceKind,'available');assert.equal(r.verified,false);assert.equal(r.executionEnabled,false);assert.equal(r.ledgerMutationPerformed,false)});
test('rejects wrong network, contract, malformed balance, and unexpected wallet',()=>{for(const patch of [{network:'NILE_TESTNET'},{tokenContract:'wrong'},{availableBalanceBaseUnits:'1.2'},{walletAddress:'THPvaUhoh2Qn2y9THCZML3H815hhFhn5YC'}]){const r=normalizeFystackUsdtSnapshot({...valid(),...patch},{walletAddress:valid().walletAddress});assert.equal(r.snapshot,null);assert.ok(r.blockers.length)}});
test('rejects missing identity and ambiguous balance semantics',()=>{for(const patch of [{workspaceId:''},{walletId:''},{balanceKind:'total'},{balanceKind:'held'}]){assert.equal(normalizeFystackUsdtSnapshot({...valid(),...patch}).snapshot,null)}});
test('rejects stale and future snapshots',()=>{const now=Date.now();for(const checkedAt of [new Date(now-121000).toISOString(),new Date(now+1000).toISOString()]){assert.equal(normalizeFystackUsdtSnapshot({...valid(),checkedAt},{},now).snapshot,null)}});
test('missing client fails closed and exposes no write methods',async()=>{const a=createFystackReadOnlyAdapter();const r=await a.getUsdtSnapshot();assert.equal(r.snapshot,null);assert.equal(r.executionEnabled,false);assert.deepEqual(Object.keys(a),['getUsdtSnapshot'])});
test('client errors fail closed',async()=>{const a=createFystackReadOnlyAdapter({client:{getWalletUsdtSnapshot:async()=>{throw Error('offline')}}});const r=await a.getUsdtSnapshot();assert.equal(r.snapshot,null);assert.equal(r.ledgerMutationPerformed,false)});

test('rejects numeric base-unit values to prevent precision loss',()=>{
 for(const availableBalanceBaseUnits of [0,1,Number.MAX_SAFE_INTEGER,1e30]){
  const r=normalizeFystackUsdtSnapshot({...valid(),availableBalanceBaseUnits})
  assert.equal(r.snapshot,null)
  assert.ok(r.blockers.includes('provider-available-usdt-balance-invalid'))
 }
})
test('preserves exact large integer base-unit strings without numeric coercion',()=>{
 const value='999999999999999999999999999999999999999999999999'
 const r=normalizeFystackUsdtSnapshot({...valid(),availableBalanceBaseUnits:value})
 assert.equal(r.snapshot.balanceBaseUnits,value)
 assert.equal(r.verified,false)
 assert.equal(r.payoutAuthorized,false)
 assert.equal(r.executionEnabled,false)
})

test('binds provider snapshots to the configured workspace and wallet identifiers',()=>{
 const raw=valid()
 const expected={workspaceId:raw.workspaceId,walletId:raw.walletId,walletAddress:raw.walletAddress}
 assert.ok(normalizeFystackUsdtSnapshot(raw,expected).snapshot)
 for(const patch of [{workspaceId:'ws_other123'},{walletId:'wal_other123'},{walletAddress:'TQ9k4W8v2h7x3p6m5n4b1c8d9e2f7g6h5j'}]){
  const r=normalizeFystackUsdtSnapshot({...raw,...patch},expected)
  assert.equal(r.snapshot,null)
  assert.ok(r.blockers.length>0)
 }
})
test('read-only adapter exposes no provider mutation capability',()=>{
 const adapter=createFystackReadOnlyAdapter({client:{getWalletUsdtSnapshot:async()=>valid(),send:async()=>{},withdraw:async()=>{},sign:async()=>{},broadcast:async()=>{}}})
 assert.deepEqual(Object.keys(adapter),['getUsdtSnapshot'])
})


test('rejects invalid clocks and freshness windows instead of accepting snapshots',()=>{
 const raw=valid(), nowMs=Date.parse(raw.checkedAt)
 for(const options of [{nowMs:NaN},{nowMs:Infinity},{maxAgeMs:Infinity},{maxAgeMs:-1}]){
  const r=normalizeFystackUsdtSnapshot(raw,{},options)
  assert.equal(r.snapshot,null)
  assert.ok(r.blockers.includes('provider-snapshot-stale-or-invalid'))
  assert.equal(r.executionEnabled,false)
 }
})
