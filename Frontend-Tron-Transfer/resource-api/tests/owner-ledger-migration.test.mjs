import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const migrationUrl = new URL('../migrations/20261122_backend_wallet_auth.sql', import.meta.url)
const operationMigrationUrl = new URL('../migrations/20261123_owner_operation_ledger.sql', import.meta.url)
const usdtWithdrawalMigrationUrl = new URL('../migrations/20261127_owner_usdt_withdrawal.sql', import.meta.url)
const sessionGroupMigrationUrl = new URL('../migrations/20261128_shared_owner_sponsor_session_groups.sql', import.meta.url)

test('Owner operation ledger migration has complete bounded validation constraints', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  assert.match(sql, /idempotency_key TEXT NOT NULL CHECK \(idempotency_key ~ '\^\[A-Za-z0-9\._:-\]\{16,160\}\$'\)/)
  assert.match(sql, /contract_address TEXT NOT NULL CHECK \(contract_address ~ '\^T\[1-9A-HJ-NP-Za-km-z\]\{33\}\$'\)/)
  assert.match(sql, /intent_sha256 CHAR\(64\) NOT NULL CHECK \(intent_sha256 ~ '\^\[0-9a-f\]\{64\}\$'\)/)
  assert.match(sql, /transaction_id CHAR\(64\) CHECK \(transaction_id IS NULL OR transaction_id ~ '\^\[0-9a-f\]\{64\}\$'\)/)
  assert.match(sql, /UNIQUE \(wallet_role, idempotency_key\)/)
  assert.match(sql, /REFERENCES public\.tron_transfer_wallet_sessions\(session_id\)/)
})

test('Owner operation ledger migration remains transactionally wrapped', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  const executableSql = sql.replace(/^\s*(?:--[^\n]*\n\s*)*/, '')
  assert.match(executableSql, /^BEGIN;/)
  assert.match(executableSql.trimEnd(), /COMMIT;$/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.tron_transfer_owner_operations/)
})

test('Owner operation lifecycle migration adds atomic confirmation and session-independent Owner recovery without enabling execution', async () => {
  const sql = await readFile(operationMigrationUrl, 'utf8')
  const executableSql = sql.replace(/^\s*(?:--[^\n]*\n\s*)*/, '')
  assert.match(executableSql, /^BEGIN;/)
  assert.match(executableSql.trimEnd(), /COMMIT;$/)
  assert.match(sql, /ALTER COLUMN session_id DROP NOT NULL/)
  assert.match(sql, /FOREIGN KEY \(session_id\).*ON DELETE SET NULL/)
  assert.match(sql, /DROP CONSTRAINT IF EXISTS tron_transfer_owner_operations_state_check/)
  assert.match(sql, /ADD CONSTRAINT tron_transfer_owner_operations_state_check CHECK/)
  assert.match(sql, /'awaiting-confirmation', 'confirming',/)
  assert.match(sql, /WHERE state IN \('confirming', 'signed', 'broadcast-unknown', 'broadcast'\)/)
  assert.match(sql, /intent->>'ownerAddress'/)
  assert.doesNotMatch(sql, /OWNER_OPERATION_EXECUTION_ENABLED|sendRawTransaction|TRON_OWNER_PRIVATE_KEY/)
})

test('Official USDT withdrawal migration adds only the explicit transfer operation type', async () => {
  const sql = await readFile(usdtWithdrawalMigrationUrl, 'utf8')
  const executableSql = sql.replace(/^\s*(?:--[^\n]*\n\s*)*/, '')
  assert.match(executableSql, /^BEGIN;/)
  assert.match(executableSql.trimEnd(), /COMMIT;$/)
  assert.match(sql, /DROP CONSTRAINT IF EXISTS tron_transfer_owner_operations_operation_type_check/)
  assert.match(sql, /ADD CONSTRAINT tron_transfer_owner_operations_operation_type_check CHECK/)
  assert.match(sql, /'transfer', 'usdt-transfer'/)
  assert.doesNotMatch(sql, /CREATE TABLE|DROP TABLE|OWNER_OPERATION_EXECUTION_ENABLED|sendRawTransaction/)
})

test('Owner Admin migration postflight requires the official USDT operation constraint', async () => {
  const script = await readFile(new URL('../scripts/migrate-owner-admin-ledgers.mjs', import.meta.url), 'utf8')
  assert.match(script, /official_usdt_withdrawal_operation/)
  assert.match(script, /tron_transfer_owner_operations_operation_type_check/)
  assert.match(script, /LIKE '%usdt-transfer%'/)
})


test('Paired Owner and Sponsor session migration preserves independent tokens and legacy sessions', async () => {
  const sql = await readFile(sessionGroupMigrationUrl, 'utf8')
  assert.match(sql, /ALTER TABLE public\.tron_transfer_wallet_sessions/)
  assert.match(sql, /ADD COLUMN IF NOT EXISTS session_group_id UUID/)
  assert.match(sql, /CREATE INDEX IF NOT EXISTS tron_transfer_wallet_sessions_group_active/)
  assert.match(sql, /WHERE session_group_id IS NOT NULL AND revoked_at IS NULL/)
  assert.doesNotMatch(sql, /DROP COLUMN|DELETE FROM|UPDATE public\.tron_transfer_wallet_sessions/)
})
