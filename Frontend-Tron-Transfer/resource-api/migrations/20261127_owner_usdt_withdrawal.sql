-- Allow the explicitly pinned official Mainnet USDT transfer operation in the
-- existing Owner operation ledger. This does not enable signing or broadcast.
-- Apply only after the existing Owner ledger migration and a verified backup.

BEGIN;

ALTER TABLE public.tron_transfer_owner_operations
  DROP CONSTRAINT IF EXISTS tron_transfer_owner_operations_operation_type_check;

ALTER TABLE public.tron_transfer_owner_operations
  ADD CONSTRAINT tron_transfer_owner_operations_operation_type_check CHECK (operation_type IN (
    'deploy', 'owner-issue', 'credit', 'batch-credit', 'transfer', 'usdt-transfer',
    'pause', 'unpause', 'minting-enable', 'minting-disable',
    'ownership-transfer', 'ownership-accept'
  ));

COMMIT;
