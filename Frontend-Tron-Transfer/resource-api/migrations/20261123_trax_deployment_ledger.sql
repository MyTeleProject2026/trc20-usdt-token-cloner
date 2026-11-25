CREATE TABLE IF NOT EXISTS public.tron_transfer_deployments (
  operation_id UUID PRIMARY KEY,
  owner_address VARCHAR(64) NOT NULL,
  idempotency_key VARCHAR(160) NOT NULL,
  intent JSONB NOT NULL,
  intent_sha256 CHAR(64) NOT NULL,
  artifact_sha256 CHAR(64) NOT NULL,
  creation_bytecode_sha256 CHAR(64) NOT NULL,
  runtime_bytecode_sha256 CHAR(64) NOT NULL,
  transaction_id CHAR(64) NOT NULL,
  unsigned_transaction JSONB NOT NULL,
  signed_transaction JSONB,
  preflight JSONB NOT NULL,
  receipt JSONB,
  contract_address VARCHAR(64),
  state TEXT NOT NULL CHECK (state IN ('prepared','confirming','signed','broadcast-unknown','broadcast','confirmed','failed','cancelled')),
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  signed_at TIMESTAMPTZ,
  broadcast_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  CONSTRAINT tron_transfer_deployments_owner_idempotency UNIQUE (owner_address,idempotency_key),
  CONSTRAINT tron_transfer_deployments_txid_unique UNIQUE (transaction_id),
  CONSTRAINT tron_transfer_deployments_owner_format CHECK (owner_address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$'),
  CONSTRAINT tron_transfer_deployments_hashes CHECK (
    intent_sha256 ~ '^[0-9a-f]{64}$' AND artifact_sha256 ~ '^[0-9a-f]{64}$'
    AND creation_bytecode_sha256 ~ '^[0-9a-f]{64}$' AND runtime_bytecode_sha256 ~ '^[0-9a-f]{64}$'
  )
);
CREATE INDEX IF NOT EXISTS tron_transfer_deployments_owner_created_idx
  ON public.tron_transfer_deployments (owner_address,created_at DESC);
CREATE INDEX IF NOT EXISTS tron_transfer_deployments_state_updated_idx
  ON public.tron_transfer_deployments (state,updated_at);
