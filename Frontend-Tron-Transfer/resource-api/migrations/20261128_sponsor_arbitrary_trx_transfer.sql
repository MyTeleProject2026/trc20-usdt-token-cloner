-- Add arbitrary-recipient native TRX transfers for the existing Sponsor wallet.
-- Preserve the configured Owner identity separately from the operation recipient.
-- This migration does not release Sponsor writes or enable Mainnet execution.
BEGIN;

ALTER TABLE public.tron_transfer_sponsor_operations
  ADD COLUMN IF NOT EXISTS recipient_address TEXT;
UPDATE public.tron_transfer_sponsor_operations
  SET recipient_address = owner_address
  WHERE recipient_address IS NULL;
ALTER TABLE public.tron_transfer_sponsor_operations
  ALTER COLUMN recipient_address SET NOT NULL;
ALTER TABLE public.tron_transfer_sponsor_operations
  DROP CONSTRAINT IF EXISTS tron_transfer_sponsor_operations_recipient_address_check;
ALTER TABLE public.tron_transfer_sponsor_operations
  ADD CONSTRAINT tron_transfer_sponsor_operations_recipient_address_check
  CHECK (recipient_address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$');

ALTER TABLE public.tron_transfer_sponsor_operations
  DROP CONSTRAINT IF EXISTS tron_transfer_sponsor_operations_operation_check;
ALTER TABLE public.tron_transfer_sponsor_operations
  ADD CONSTRAINT tron_transfer_sponsor_operations_operation_check
  CHECK (operation IN ('stake','delegate','undelegate','unstake','withdraw','topup','transfer'));

COMMIT;
