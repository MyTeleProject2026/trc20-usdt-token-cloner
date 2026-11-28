# Sponsor Stake 2.0 transaction engine

This engine is server-side and Mainnet-only. It reads the Sponsor key only from the server environment, verifies that it derives `SPONSOR_MAINNET_ADDRESS`, and never accepts or returns key material. Do not commit private keys, keystores, mnemonics, or backup phrases. Do not place them in frontend storage or API request bodies.

## Required configuration

- `SPONSOR_MAINNET_ADDRESS`: dedicated Sponsor address.
- `TRON_OWNER_ADDRESS` (or existing `TRON_OWNER_WALLET_ADDRESS`): existing Owner address; must differ from Sponsor.
- `SPONSOR_MAINNET_PRIVATE_KEY`: Sponsor key stored as a Render secret/environment secret.
- `SPONSOR_ADMIN_TOKEN`: high-entropy administrator bearer token (at least 32 characters).
- `DATABASE_URL`: durable PostgreSQL required for the idempotency ledger.
- `SPONSOR_LIQUID_RESERVE_TRX`: protected liquid TRX reserve (default 2 TRX).
- `SPONSOR_TRANSACTION_ENGINE_ENABLED=true` and `SPONSOR_MAINNET_BROADCAST_ENABLED=true`: both are required to enable signing/broadcast. Both are intentionally absent/false by default.

Never enable both execution flags until the Sponsor address/key, Owner address, Render secret handling, database backups, monitoring, and Mainnet transaction policy have been independently reviewed. A request also requires administrator authentication, a unique idempotency key, and the exact per-operation confirmation phrase. The engine is not enabled by adding a UI setting alone.

## API

`POST /api/tron/sponsor/transaction/execute`

Body fields: `operation` (`stake` or `delegate`), `amountSun` (integer string), `resource` (`ENERGY` or `BANDWIDTH`), `idempotencyKey` (24–128 characters), and `confirmPhrase` exactly `CONFIRM TRON MAINNET SPONSOR TRANSACTION`.

The Sponsor address and Owner recipient are always read from server configuration, not from the request. The route stores a hash of the idempotency key and request intent before calling the signer. A repeated key never replays the transaction. Ambiguous broadcasts remain non-retryable and require manual chain reconciliation.

Stake preflight reserves the configured liquid TRX amount. Delegation preflight checks already-frozen delegatable capacity; delegation does not incorrectly treat its amount as a liquid TRX spend. After broadcast, the engine verifies the solidified transaction body, operation, Sponsor, resource and amount. Delegation additionally checks the solidified delegation record and Owner resource state.

## Safety boundary

This is a transaction execution capability, not a guarantee of free resources or fee sponsorship. Stake 2.0 locks TRX and delegation makes the corresponding frozen resource available to the Owner; it does not pay TRX transaction fees by itself. The Sponsor still needs liquid TRX for transaction fees and an adequate reserve. No automatic unstaking is provided.

A broadcast accepted by a node is not the same as solidified confirmation. If the broadcast result is ambiguous or solidification is not yet visible, the durable idempotency record blocks a retry. Reconcile the transaction ID against Mainnet before any manual intervention.

This change does not deploy, mint, transfer, or modify the TRӾ contract.
