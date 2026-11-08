-- Stage 10C: recipient network acknowledgement and solidified delivery evidence.
-- Manual migration only. Application startup does not execute this file.
ALTER TABLE trc20_token_clone.owner_direct_withdrawals
  ADD COLUMN IF NOT EXISTS recipient_network TEXT NOT NULL DEFAULT 'TRON_MAINNET_TRC20',
  ADD COLUMN IF NOT EXISTS recipient_network_confirmed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS confirmation_block_number BIGINT,
  ADD COLUMN IF NOT EXISTS confirmation_event_index INTEGER,
  ADD COLUMN IF NOT EXISTS confirmation_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS exchange_credit_status TEXT NOT NULL DEFAULT 'not-verifiable';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'owner_direct_withdrawals_recipient_network_check'
      AND conrelid = 'trc20_token_clone.owner_direct_withdrawals'::regclass
  ) THEN
    ALTER TABLE trc20_token_clone.owner_direct_withdrawals
      ADD CONSTRAINT owner_direct_withdrawals_recipient_network_check
      CHECK (recipient_network = 'TRON_MAINNET_TRC20') NOT VALID;
  END IF;
END $$;
