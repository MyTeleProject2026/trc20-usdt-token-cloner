-- Versioned Sponsor operations ledger schema.
-- This migration is idempotent and always preserves the paused write-control row.
BEGIN;

CREATE TABLE IF NOT EXISTS public.tron_transfer_sponsor_operations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key_hash CHAR(64) NOT NULL UNIQUE,
  request_hash CHAR(64) NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('stake','delegate','undelegate','unstake','withdraw','topup')),
  resource TEXT NOT NULL CHECK (resource IN ('ENERGY','BANDWIDTH','TRX')),
  amount_sun NUMERIC(21,0) NOT NULL CHECK (amount_sun > 0),
  sponsor_address TEXT NOT NULL,
  owner_address TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved','signed-not-broadcast','broadcast-unknown','confirmed','failed')),
  transaction_id CHAR(64),
  prepared_transaction JSONB,
  signed_transaction JSONB,
  result_code TEXT,
  confirmation_block BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.tron_transfer_sponsor_operations
  ADD COLUMN IF NOT EXISTS prepared_transaction JSONB;
ALTER TABLE public.tron_transfer_sponsor_operations
  ADD COLUMN IF NOT EXISTS signed_transaction JSONB;
ALTER TABLE public.tron_transfer_sponsor_operations
  DROP CONSTRAINT IF EXISTS tron_transfer_sponsor_operations_operation_check;
ALTER TABLE public.tron_transfer_sponsor_operations
  ADD CONSTRAINT tron_transfer_sponsor_operations_operation_check
  CHECK (operation IN ('stake','delegate','undelegate','unstake','withdraw','topup'));
ALTER TABLE public.tron_transfer_sponsor_operations
  DROP CONSTRAINT IF EXISTS tron_transfer_sponsor_operations_resource_check;
ALTER TABLE public.tron_transfer_sponsor_operations
  ADD CONSTRAINT tron_transfer_sponsor_operations_resource_check
  CHECK (resource IN ('ENERGY','BANDWIDTH','TRX'));

CREATE INDEX IF NOT EXISTS tron_transfer_sponsor_operations_sponsor_created
  ON public.tron_transfer_sponsor_operations (sponsor_address, created_at DESC);

CREATE TABLE IF NOT EXISTS public.tron_transfer_sponsor_control (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  writes_paused BOOLEAN NOT NULL DEFAULT TRUE,
  pause_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.tron_transfer_sponsor_control (id, writes_paused, pause_reason)
VALUES (1, TRUE, 'schema-bootstrap-requires-explicit-cutover')
ON CONFLICT (id) DO NOTHING;

COMMIT;
