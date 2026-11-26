-- Record successful local wallet-key control checks without retaining signatures.
-- The audit payload contains only the role, public address, session ID and timestamp.
BEGIN;

ALTER TABLE public.tron_transfer_wallet_auth_audit
  DROP CONSTRAINT IF EXISTS tron_transfer_wallet_auth_audit_event_type_check;

ALTER TABLE public.tron_transfer_wallet_auth_audit
  ADD CONSTRAINT tron_transfer_wallet_auth_audit_event_type_check
  CHECK (event_type IN (
    'enrollment_succeeded',
    'login_succeeded',
    'login_failed',
    'session_revoked',
    'password_changed',
    'account_locked',
    'enrollment_rejected',
    'signer_acceptance_verified'
  ));

CREATE INDEX IF NOT EXISTS tron_transfer_wallet_auth_audit_signer_acceptance
  ON public.tron_transfer_wallet_auth_audit (wallet_role, created_at DESC)
  WHERE event_type = 'signer_acceptance_verified';

COMMIT;
