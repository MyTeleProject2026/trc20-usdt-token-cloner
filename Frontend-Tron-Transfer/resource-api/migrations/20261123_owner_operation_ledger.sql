-- Extend the existing Owner operation lifecycle with an atomic confirmation claim.
-- Apply 20261122_backend_wallet_auth.sql first. This is additive and does not
-- enable execution or broadcast; production remains gated by verified backup/restore.

BEGIN;

ALTER TABLE public.tron_transfer_owner_operations
  DROP CONSTRAINT IF EXISTS tron_transfer_owner_operations_state_check;

ALTER TABLE public.tron_transfer_owner_operations
  ADD CONSTRAINT tron_transfer_owner_operations_state_check CHECK (state IN (
    'created', 'preflight-passed', 'awaiting-confirmation', 'confirming',
    'signed', 'broadcast-unknown', 'broadcast', 'confirmed', 'failed', 'cancelled'
  ));

CREATE INDEX IF NOT EXISTS tron_transfer_owner_operations_recovery
  ON public.tron_transfer_owner_operations (state, updated_at)
  WHERE state IN ('confirming', 'signed', 'broadcast-unknown', 'broadcast');

COMMIT;
