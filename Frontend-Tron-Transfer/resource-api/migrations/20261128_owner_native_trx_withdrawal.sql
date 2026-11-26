-- Add native TRX transfers to the existing guarded Owner operation ledger.
-- The asset marker TRX is not a contract address. No execution gate is enabled.
BEGIN;

ALTER TABLE public.tron_transfer_owner_operations
  DROP CONSTRAINT IF EXISTS tron_transfer_owner_operations_contract_address_check;
ALTER TABLE public.tron_transfer_owner_operations
  ADD CONSTRAINT tron_transfer_owner_operations_contract_address_check
  CHECK (contract_address = 'TRX' OR contract_address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$');

ALTER TABLE public.tron_transfer_owner_operations
  DROP CONSTRAINT IF EXISTS tron_transfer_owner_operations_operation_type_check;
ALTER TABLE public.tron_transfer_owner_operations
  ADD CONSTRAINT tron_transfer_owner_operations_operation_type_check CHECK (operation_type IN (
    'deploy', 'owner-issue', 'credit', 'batch-credit', 'transfer', 'usdt-transfer', 'trx-transfer',
    'pause', 'unpause', 'minting-enable', 'minting-disable', 'ownership-transfer', 'ownership-accept'
  ));

COMMIT;
