-- Durable Owner transaction operation ledger.
-- Additive only: this migration does not enable transaction execution or broadcast.
-- Apply only after a verified Neon backup and during a controlled maintenance window.

BEGIN;

CREATE TABLE IF NOT EXISTS public.tron_transfer_owner_operations (
  operation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_role TEXT NOT NULL DEFAULT 'owner' CHECK (wallet_role = 'owner'),
  session_id BIGINT REFERENCES public.tron_transfer_wallet_sessions(session_id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 160),
  operation_type TEXT NOT NULL CHECK (operation_type IN (
    'deploy', 'owner-issue', 'credit', 'batch-credit', 'transfer',
    'pause', 'unpause', 'minting-enable', 'minting-disable',
    'ownership-transfer', 'ownership-accept'
  )),
  contract_address TEXT NOT NULL CHECK (contract_address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$'),
  intent JSONB NOT NULL CHECK (jsonb_typeof(intent) = 'object'),
  intent_sha256 CHAR(64) NOT NULL CHECK (intent_sha256 ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL DEFAULT 'created' CHECK (state IN (
    'created', 'preflight-passed', 'awaiting-confirmation', 'confirming', 'signed',
    'broadcast-unknown', 'broadcast', 'confirmed', 'failed', 'cancelled'
  )),
  transaction_id CHAR(64) UNIQUE CHECK (transaction_id IS NULL OR transaction_id ~ '^[0-9a-f]{64}$'),
  block_number BIGINT CHECK (block_number IS NULL OR block_number >= 0),
  receipt JSONB,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  signed_at TIMESTAMPTZ,
  broadcast_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  UNIQUE (wallet_role, idempotency_key)
);

CREATE INDEX IF NOT EXISTS tron_transfer_owner_operations_recent
  ON public.tron_transfer_owner_operations (created_at DESC);

CREATE INDEX IF NOT EXISTS tron_transfer_owner_operations_recovery
  ON public.tron_transfer_owner_operations (state, updated_at)
  WHERE state IN ('confirming', 'signed', 'broadcast-unknown', 'broadcast');

COMMIT;
