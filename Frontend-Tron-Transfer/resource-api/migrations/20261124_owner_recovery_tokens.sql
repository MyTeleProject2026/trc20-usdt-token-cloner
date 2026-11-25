-- One-time Owner password recovery tokens. Tokens are generated offline by the
-- operator CLI, stored only as SHA-256 digests, expire quickly, and are single-use.
CREATE TABLE IF NOT EXISTS public.tron_transfer_wallet_recovery_tokens (
  recovery_token_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);
CREATE INDEX IF NOT EXISTS tron_transfer_wallet_recovery_tokens_active
  ON public.tron_transfer_wallet_recovery_tokens (expires_at)
  WHERE consumed_at IS NULL;
