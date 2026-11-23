import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const migrationUrl = new URL('../migrations/20261122_backend_wallet_auth.sql', import.meta.url)

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
  assert.match(sql, /^BEGIN;/)
  assert.match(sql.trimEnd(), /COMMIT;$/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.tron_transfer_owner_operations/)
})
