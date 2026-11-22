-- Durable Owner operation ledger. This migration creates records only.
-- It does not enable Mainnet execution or broadcast transactions.
BEGIN;

CREATE TABLE IF NOT EXISTS public.tron_transfer_owner_operations (
  operation_id UUID PRIMARY KEY,
  wallet_role TEXT NOT NULL DEFAULT 'owner' CHECK (wallet_role = 'owner'),
  owner_address TEXT NOT NULL CHECK (owner_address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$'),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  intent_hash CHAR(64) NOT NULL CHECK (intent_hash ~ '^[0-9a-f]{64}$'),
  operation_type TEXT NOT NULL CHECK (operation_type IN (
    'deploy', 'owner_credit', 'external_credit', 'batch_credit', 'transfer',
    'pause', 'unpause', 'enable_minting', 'disable_minting',
    'propose_owner', 'accept_owner'
  )),
  contract_address TEXT,
  intent JSONB NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'authorized', 'preflight_passed', 'signed', 'broadcast',
    'confirmed', 'failed', 'rejected', 'unknown'
  )),
  transaction_id CHAR(64),
  block_number BIGINT,
  failure_code TEXT,
  preflight JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ,
  UNIQUE (owner_address, idempotency_key),
  CHECK (transaction_id IS NULL OR transaction_id ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS tron_transfer_owner_operations_recent
  ON public.tron_transfer_owner_operations (owner_address, created_at DESC);
CREATE INDEX IF NOT EXISTS tron_transfer_owner_operations_recovery
  ON public.tron_transfer_owner_operations (state, updated_at)
  WHERE state IN ('signed', 'broadcast', 'unknown');

COMMIT;
