import test from 'node:test'
import assert from 'node:assert/strict'
import { applyOwnerAdminMigrations } from '../scripts/migrate-owner-admin-ledgers.mjs'

test('Owner Admin migrations apply atomically and skip matching checksums',async()=>{
 const applied=new Map(),calls=[]
 const client={async query(sql,params=[]){
  calls.push(sql.trim().split(/\s+/).slice(0,3).join(' '))
  if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK')return{rows:[]}
  if(sql.includes('pg_advisory_xact_lock')||sql.includes('CREATE TABLE IF NOT EXISTS public.tron_transfer_owner_admin_schema_migrations'))return{rows:[]}
  if(sql.startsWith('SELECT checksum'))return{rows:applied.has(params[0])?[{checksum:applied.get(params[0])}]:[]}
  if(sql.startsWith('INSERT INTO public.tron_transfer_owner_admin_schema_migrations')){applied.set(params[0],params[1]);return{rows:[]}}
  return{rows:[]}
 }}
 const migrations=[{version:'20261122_backend_wallet_auth.sql',sql:'CREATE TABLE wallet_accounts(id int);'},{version:'20261123_owner_operation_ledger.sql',sql:'CREATE TABLE owner_operations(id int);'}]
 const first=await applyOwnerAdminMigrations(client,migrations)
 assert.equal(first.applied.length,2)
 assert.equal(first.skipped.length,0)
 const second=await applyOwnerAdminMigrations(client,migrations)
 assert.equal(second.applied.length,0)
 assert.equal(second.skipped.length,2)
 assert.equal(calls.filter(x=>x==='CREATE TABLE wallet_accounts(id').length,1)
})

test('Owner Admin migration runner rejects a changed checksum for an applied version',async()=>{
 const client={async query(sql,params=[]){
  if(sql==='BEGIN'||sql==='ROLLBACK')return{rows:[]}
  if(sql.includes('pg_advisory_xact_lock')||sql.includes('CREATE TABLE IF NOT EXISTS public.tron_transfer_owner_admin_schema_migrations'))return{rows:[]}
  if(sql.startsWith('SELECT checksum'))return{rows:[{checksum:'0'.repeat(64)}]}
  return{rows:[]}
 }}
 await assert.rejects(()=>applyOwnerAdminMigrations(client,[{version:'20261122_backend_wallet_auth.sql',sql:'CREATE TABLE altered(id int);'}]),/checksum changed/)
})
