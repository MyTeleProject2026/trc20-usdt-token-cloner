-- Extend one-time recovery tokens to both independently managed wallet accounts.
-- Existing rows are Owner recovery tokens; the default preserves that meaning.
ALTER TABLE public.tron_transfer_wallet_recovery_tokens
  ADD COLUMN wallet_role TEXT NOT NULL DEFAULT 'owner'
  CHECK (wallet_role IN ('owner','sponsor'));

CREATE INDEX tron_transfer_wallet_recovery_tokens_role_active
  ON public.tron_transfer_wallet_recovery_tokens (wallet_role, expires_at)
  WHERE consumed_at IS NULL;
