import test from 'node:test'
import assert from 'node:assert/strict'
import { applyOwnerAdminMigrations, stripOuterTransactionEnvelope, LEGACY_MIGRATION_CHECKSUMS, OWNER_ADMIN_SCHEMA_FINGERPRINT, getOwnerAdminSchemaFingerprint, ownerAdminDatabaseIdentityFingerprint, assertOwnerAdminDatabaseIdentity, assertOwnerAdminMigrationSafety } from '../scripts/migrate-owner-admin-ledgers.mjs'
import { readFile } from 'node:fs/promises'

test('Owner Admin migration target fingerprint pins host, database, port and role without exposing credentials',()=>{
 const first=ownerAdminDatabaseIdentityFingerprint('postgresql://neondb_owner:secret@ep-example.c-9.us-east-2.aws.neon.tech:5432/tron_transfer?sslmode=require')
 const same=ownerAdminDatabaseIdentityFingerprint('postgres://neondb_owner:other-secret@EP-EXAMPLE.C-9.US-EAST-2.AWS.NEON.TECH/tron_transfer')
 const differentRole=ownerAdminDatabaseIdentityFingerprint('postgresql://other_role:secret@ep-example.c-9.us-east-2.aws.neon.tech:5432/tron_transfer')
 const differentDatabase=ownerAdminDatabaseIdentityFingerprint('postgresql://neondb_owner:secret@ep-example.c-9.us-east-2.aws.neon.tech:5432/other_db')
 assert.equal(first,same)
 assert.notEqual(first,differentRole)
 assert.notEqual(first,differentDatabase)
 assert.match(first,/^[0-9a-f]{64}$/)
 assert.ok(!JSON.stringify({first}).includes('secret'))
 assert.equal(assertOwnerAdminDatabaseIdentity('postgresql://neondb_owner:secret@ep-example.c-9.us-east-2.aws.neon.tech:5432/tron_transfer?sslmode=require',first),first)
 assert.throws(()=>assertOwnerAdminDatabaseIdentity('postgresql://other_role:secret@ep-example.c-9.us-east-2.aws.neon.tech:5432/tron_transfer',first),/owner-admin-database-identity-mismatch/)
 assert.throws(()=>assertOwnerAdminDatabaseIdentity('postgresql://neondb_owner:secret@ep-example.c-9.us-east-2.aws.neon.tech:5432/tron_transfer',''),/missing-owner-admin-database-identity-pin/)
})

test('Owner Admin migration target fingerprint rejects pooler URLs only at main guard, not identity parsing',()=>{
 assert.throws(()=>ownerAdminDatabaseIdentityFingerprint('not-a-database-url'),/invalid-owner-admin-database-url/)
 assert.throws(()=>ownerAdminDatabaseIdentityFingerprint('https://example.com/db'),/invalid-owner-admin-database-url/)
})


test('Owner Admin schema fingerprint reads the stable catalog manifest',async()=>{
 assert.equal(OWNER_ADMIN_SCHEMA_FINGERPRINT,'d791bd80a73d966365e717ac7f72e1525f4df1c2fac1d0096c2f8aea5c5ad8ea','Pin the catalog fingerprint verified against the current production and restored Neon branches.');
 let statement=''
 const fingerprint=await getOwnerAdminSchemaFingerprint({async query(sql){statement=sql;return{rows:[{fingerprint:OWNER_ADMIN_SCHEMA_FINGERPRINT}]}}})
 assert.equal(fingerprint,OWNER_ADMIN_SCHEMA_FINGERPRINT)
 assert.ok(statement.includes('tron_transfer_wallet_accounts'))
 assert.ok(statement.includes('pg_get_constraintdef'))
 assert.ok(statement.includes('pg_get_indexdef') || statement.includes('pg_indexes'))
 assert.ok(!statement.includes('tron_transfer_sponsor_operations'))
 const separators=[...statement.matchAll(/E'(\\+)n'/g)].map(match=>match[1].length)
 assert.ok(separators.length>0)
 assert.ok(separators.every(length=>length===2),'runtime SQL must preserve the exact two-backslash separator used by the pinned fingerprint')
})

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


test('known legacy migration checksums reconcile only after the complete Owner schema fingerprint matches',async()=>{
 const version='20261122_backend_wallet_auth.sql'
 const legacy=LEGACY_MIGRATION_CHECKSUMS[version][0]
 const applied=new Map([[version,legacy]])
 const updates=[]
 const client={async query(sql,params=[]){
  if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK')return{rows:[]}
  if(sql.includes('pg_advisory_xact_lock')||sql.includes('CREATE TABLE IF NOT EXISTS public.tron_transfer_owner_admin_schema_migrations'))return{rows:[]}
  if(sql.startsWith('SELECT checksum'))return{rows:[{checksum:applied.get(params[0])}]}
  if(sql.startsWith('UPDATE public.tron_transfer_owner_admin_schema_migrations')){
   updates.push({sql,params});applied.set(params[1],params[0]);return{rows:[]}
  }
  return{rows:[]}
 }}
 const result=await applyOwnerAdminMigrations(client,[{version,sql:'CREATE TABLE wallet_accounts(id int);'}],null,{
  readSchemaFingerprint:async()=>OWNER_ADMIN_SCHEMA_FINGERPRINT,
 })
 assert.equal(result.applied.length,0)
 assert.deepEqual(result.skipped,[version])
 assert.equal(result.legacyChecksumsReconciled,true)
 assert.equal(updates.length,1)
 assert.equal(updates[0].params[2],legacy)
 assert.equal(updates[0].params[0].length,64)
})

test('known legacy migration checksum is not rewritten when the live schema fingerprint differs',async()=>{
 const version='20261122_backend_wallet_auth.sql'
 const applied=new Map([[version,LEGACY_MIGRATION_CHECKSUMS[version][0]]])
 const client={async query(sql,params=[]){
  if(sql==='BEGIN'||sql==='ROLLBACK')return{rows:[]}
  if(sql.includes('pg_advisory_xact_lock')||sql.includes('CREATE TABLE IF NOT EXISTS public.tron_transfer_owner_admin_schema_migrations'))return{rows:[]}
  if(sql.startsWith('SELECT checksum'))return{rows:[{checksum:applied.get(params[0])}]}
  if(sql.startsWith('UPDATE public.tron_transfer_owner_admin_schema_migrations'))throw new Error('checksum must not be updated')
  return{rows:[]}
 }}
 await assert.rejects(()=>applyOwnerAdminMigrations(client,[{version,sql:'CREATE TABLE wallet_accounts(id int);'}],null,{
  readSchemaFingerprint:async()=>'different-schema',
 }),/schema fingerprint does not match/)
})

test('transaction-wrapped migration files cannot commit the orchestrator transaction early',async()=>{
 const applied=new Map(),statements=[]
 const client={async query(sql,params=[]){
  const statement=String(sql).trim()
  statements.push(statement)
  if(statement==='BEGIN'||statement==='COMMIT'||statement==='ROLLBACK')return{rows:[]}
  if(statement.includes('pg_advisory_xact_lock')||statement.includes('CREATE TABLE IF NOT EXISTS public.tron_transfer_owner_admin_schema_migrations'))return{rows:[]}
  if(statement.startsWith('SELECT checksum'))return{rows:applied.has(params[0])?[{checksum:applied.get(params[0])}]:[]}
  if(statement.startsWith('INSERT INTO public.tron_transfer_owner_admin_schema_migrations')){applied.set(params[0],params[1]);return{rows:[]}}
  return{rows:[]}
 }}
 await applyOwnerAdminMigrations(client,[{version:'20261122_wrapped.sql',sql:`-- migration header
BEGIN;
CREATE TABLE wrapped_migration(id int);
COMMIT;`}])
 assert.equal(statements.filter(x=>x==='BEGIN').length,1)
 assert.equal(statements.filter(x=>x==='COMMIT').length,1)
 assert.ok(statements.includes('CREATE TABLE wrapped_migration(id int);'))
})

test('real Owner Admin migration files have their inner transaction envelope removed',async()=>{
 const sql=await readFile(new URL('../migrations/20261122_backend_wallet_auth.sql',import.meta.url),'utf8')
 const executable=stripOuterTransactionEnvelope(sql)
 assert.ok(executable.includes('CREATE TABLE IF NOT EXISTS public.tron_transfer_wallet_accounts'))
 assert.equal(executable.trimStart().startsWith('BEGIN;'),false)
 assert.equal(executable.trimEnd().endsWith('COMMIT;'),false)
})

test('Owner Admin migration postflight executes before commit and failure rolls back',async()=>{
 const statements=[]
 const client={async query(sql,params=[]){
  const statement=String(sql).trim();statements.push(statement)
  if(statement==='BEGIN'||statement==='ROLLBACK')return{rows:[]}
  if(statement.includes('pg_advisory_xact_lock')||statement.includes('CREATE TABLE IF NOT EXISTS public.tron_transfer_owner_admin_schema_migrations'))return{rows:[]}
  if(statement.startsWith('SELECT checksum'))return{rows:[]}
  if(statement.startsWith('INSERT INTO public.tron_transfer_owner_admin_schema_migrations'))return{rows:[]}
  return{rows:[]}
 }}
 await assert.rejects(()=>applyOwnerAdminMigrations(client,[{version:'20261122_test.sql',sql:'CREATE TABLE test_table(id int);'}],async()=>{statements.push('POSTFLIGHT');throw new Error('postflight failed')}),/postflight failed/)
 assert.ok(statements.indexOf('POSTFLIGHT')<statements.indexOf('ROLLBACK'))
 assert.ok(!statements.includes('COMMIT'))
})

test('restore-branch legacy migration checksums are accepted only behind the verified live schema fingerprint',async()=>{
 const version='20261122_backend_wallet_auth.sql'
 const legacy=LEGACY_MIGRATION_CHECKSUMS[version][1]
 const applied=new Map([[version,legacy]])
 const client={async query(sql,params=[]){
  if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK')return{rows:[]}
  if(sql.includes('pg_advisory_xact_lock')||sql.includes('CREATE TABLE IF NOT EXISTS public.tron_transfer_owner_admin_schema_migrations'))return{rows:[]}
  if(sql.startsWith('SELECT checksum'))return{rows:[{checksum:applied.get(params[0])}]}
  if(sql.startsWith('UPDATE public.tron_transfer_owner_admin_schema_migrations')){applied.set(params[1],params[0]);return{rows:[]}}
  return{rows:[]}
 }}
 const result=await applyOwnerAdminMigrations(client,[{version,sql:'CREATE TABLE wallet_accounts(id int);'}],null,{
  readSchemaFingerprint:async()=>OWNER_ADMIN_SCHEMA_FINGERPRINT,
 })
 assert.equal(result.legacyChecksumsReconciled,true)
 assert.equal(applied.get(version).length,64)
})

test('Owner Admin migration requires explicit backup and restore attestations as well as the exact acknowledgement',()=>{
 const base={
  OWNER_ADMIN_MIGRATIONS_ACK:'APPLY_TRON_TRANSFER_OWNER_ADMIN_MIGRATIONS',
  OWNER_OPERATION_LEDGER_BACKUP_VERIFIED:'true',
  OWNER_OPERATION_LEDGER_RESTORE_TESTED:'true',
 }
 assert.doesNotThrow(()=>assertOwnerAdminMigrationSafety(base))
 assert.throws(()=>assertOwnerAdminMigrationSafety({...base,OWNER_ADMIN_MIGRATIONS_ACK:''}),/OWNER_ADMIN_MIGRATIONS_ACK/)
 assert.throws(()=>assertOwnerAdminMigrationSafety({...base,OWNER_OPERATION_LEDGER_BACKUP_VERIFIED:'false'}),/backup/)
 assert.throws(()=>assertOwnerAdminMigrationSafety({...base,OWNER_OPERATION_LEDGER_RESTORE_TESTED:'false'}),/restore drill/)
})
