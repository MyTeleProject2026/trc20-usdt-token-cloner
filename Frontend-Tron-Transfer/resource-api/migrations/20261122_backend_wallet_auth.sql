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

COMMIT;
