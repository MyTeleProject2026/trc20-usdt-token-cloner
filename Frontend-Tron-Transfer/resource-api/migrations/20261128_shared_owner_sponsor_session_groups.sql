-- Correlate the independent Owner and Sponsor session tokens issued by one Owner Admin login.
-- The role tokens remain distinct to satisfy the global token_hash unique constraint.
-- Legacy sessions stay NULL and continue to authenticate/revoke by their own session_id.

BEGIN;

ALTER TABLE public.tron_transfer_wallet_sessions
  ADD COLUMN IF NOT EXISTS session_group_id UUID;

CREATE INDEX IF NOT EXISTS tron_transfer_wallet_sessions_group_active
  ON public.tron_transfer_wallet_sessions (session_group_id)
  WHERE session_group_id IS NOT NULL AND revoked_at IS NULL;

COMMIT;
