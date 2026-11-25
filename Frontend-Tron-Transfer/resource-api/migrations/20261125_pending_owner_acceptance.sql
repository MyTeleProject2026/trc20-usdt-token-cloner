-- Separate pending-owner authentication and two-step ownership acceptance ledger.
CREATE TABLE IF NOT EXISTS public.tron_transfer_pending_owner_challenges (
  challenge_id UUID PRIMARY KEY,
  contract_address VARCHAR(64) NOT NULL CHECK (contract_address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$'),
  pending_owner_address VARCHAR(64) NOT NULL CHECK (pending_owner_address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$'),
  origin TEXT NOT NULL,
  nonce_hash CHAR(64) NOT NULL UNIQUE CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
  message_hash CHAR(64) NOT NULL CHECK (message_hash ~ '^[0-9a-f]{64}$'),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > issued_at)
);
CREATE INDEX IF NOT EXISTS tron_transfer_pending_owner_challenges_rate ON public.tron_transfer_pending_owner_challenges (pending_owner_address,created_at DESC);
CREATE TABLE IF NOT EXISTS public.tron_transfer_pending_owner_sessions (
  session_id UUID PRIMARY KEY,
  token_hash CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  csrf_hash CHAR(64) NOT NULL CHECK (csrf_hash ~ '^[0-9a-f]{64}$'),
  contract_address VARCHAR(64) NOT NULL CHECK (contract_address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$'),
  pending_owner_address VARCHAR(64) NOT NULL CHECK (pending_owner_address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$'),
  origin TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS tron_transfer_pending_owner_sessions_active ON public.tron_transfer_pending_owner_sessions (pending_owner_address,expires_at) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS public.tron_transfer_pending_owner_acceptances (
  operation_id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES public.tron_transfer_pending_owner_sessions(session_id) ON DELETE RESTRICT,
  contract_address VARCHAR(64) NOT NULL CHECK (contract_address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$'),
  pending_owner_address VARCHAR(64) NOT NULL CHECK (pending_owner_address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$'),
  idempotency_key VARCHAR(160) NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{16,160}$'),
  intent JSONB NOT NULL CHECK (jsonb_typeof(intent)='object'),
  intent_sha256 CHAR(64) NOT NULL CHECK (intent_sha256 ~ '^[0-9a-f]{64}$'),
  transaction_id CHAR(64) NOT NULL CHECK (transaction_id ~ '^[0-9a-f]{64}$'),
  unsigned_transaction JSONB NOT NULL,
  signed_transaction JSONB,
  preflight JSONB NOT NULL,
  receipt JSONB,
  state TEXT NOT NULL CHECK (state IN ('prepared','confirming','signed','broadcast-unknown','broadcast','confirmed','failed','cancelled')),
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  signed_at TIMESTAMPTZ,
  broadcast_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  CONSTRAINT tron_transfer_pending_owner_idempotency UNIQUE (pending_owner_address,idempotency_key),
  CONSTRAINT tron_transfer_pending_owner_txid UNIQUE (transaction_id)
);
CREATE INDEX IF NOT EXISTS tron_transfer_pending_owner_acceptance_recent ON public.tron_transfer_pending_owner_acceptances (pending_owner_address,created_at DESC);
CREATE INDEX IF NOT EXISTS tron_transfer_pending_owner_acceptance_recovery ON public.tron_transfer_pending_owner_acceptances (state,updated_at) WHERE state IN ('confirming','signed','broadcast-unknown','broadcast');
