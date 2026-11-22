-- Backend-managed Owner/Sponsor password-account foundation.
-- Apply only after a verified database backup and during a maintenance window.
-- This migration creates storage only; it does not enroll accounts or enable signing.

BEGIN;

CREATE TABLE IF NOT EXISTS public.tron_transfer_wallet_accounts (
  wallet_role TEXT PRIMARY KEY CHECK (wallet_role IN ('owner', 'sponsor')),
  wallet_address TEXT NOT NULL UNIQUE CHECK (wallet_address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$'),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_algorithm TEXT NOT NULL CHECK (password_algorithm IN ('scrypt')),
  password_params JSONB NOT NULL DEFAULT '{"N":32768,"r":8,"p":1}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  password_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_authenticated_at TIMESTAMPTZ,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tron_transfer_wallet_sessions (
  session_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wallet_role TEXT NOT NULL REFERENCES public.tron_transfer_wallet_accounts(wallet_role) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  csrf_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  user_agent_hash CHAR(64),
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS tron_transfer_wallet_sessions_active
  ON public.tron_transfer_wallet_sessions (wallet_role, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS public.tron_transfer_wallet_auth_audit (
  audit_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wallet_role TEXT CHECK (wallet_role IN ('owner', 'sponsor')),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'enrollment_succeeded', 'login_succeeded', 'login_failed',
    'session_revoked', 'password_changed', 'account_locked',
    'enrollment_rejected'
  )),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'denied', 'error')),
  client_ip_hash CHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS tron_transfer_wallet_auth_audit_recent
  ON public.tron_transfer_wallet_auth_audit (created_at DESC);


-- Durable Owner transaction intent and recovery ledger. This table stores
-- normalized operation arguments and chain receipts, never private keys,
-- passwords, session tokens, or raw signing material.
CREATE TABLE IF NOT EXISTS public.tron_transfer_owner_operations (
  operation_id UUID PRIMARY KEY,
  wallet_role TEXT NOT NULL DEFAULT 'owner' CHECK (wallet_role = 'owner'),
  session_id BIGINT NOT NULL REFERENCES public.tron_transfer_wallet_sessions(session_id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{16,160}
),
  operation_type TEXT NOT NULL CHECK (operation_type IN (
    'deploy','owner-issue','credit','batch-credit','transfer','pause','unpause',
    'minting-enable','minting-disable','ownership-transfer','ownership-accept'
  )),
  contract_address TEXT NOT NULL CHECK (contract_address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}
),
  intent JSONB NOT NULL CHECK (jsonb_typeof(intent) = 'object'),
  intent_sha256 CHAR(64) NOT NULL CHECK (intent_sha256 ~ '^[0-9a-f]{64}
),
  state TEXT NOT NULL DEFAULT 'created' CHECK (state IN (
    'created','preflight-passed','awaiting-confirmation','signed',
    'broadcast-unknown','broadcast','confirmed','failed','cancelled'
  )),
  transaction_id CHAR(64) CHECK (transaction_id IS NULL OR transaction_id ~ '^[0-9a-f]{64}
),
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

CREATE INDEX IF NOT EXISTS tron_transfer_owner_operations_session_recent
  ON public.tron_transfer_owner_operations (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS tron_transfer_owner_operations_pending
  ON public.tron_transfer_owner_operations (state, updated_at)
  WHERE state IN ('created','preflight-passed','awaiting-confirmation','signed','broadcast-unknown','broadcast');

CREATE UNIQUE INDEX IF NOT EXISTS tron_transfer_owner_operations_txid
  ON public.tron_transfer_owner_operations (transaction_id)
  WHERE transaction_id IS NOT NULL;

COMMIT;
