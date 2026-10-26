# Sponsor reservation idempotency and operator key

This guide explains the reservation key used by the sponsor ledger. It is not a wallet key, API token, transaction hash, or proof that funds were sent.

## What the idempotency key does

`idempotencyKey` is a caller-chosen, stable identifier for one exact reservation intent. PostgreSQL enforces uniqueness. If the same key is retried with the same network, sponsor reference, purpose, asset, token contract, receiver and integer base-unit amount, the API returns the existing reservation instead of reserving budget twice. If a key is reused with different intent data, the API rejects it with `idempotency-key-conflict`.

Keep one key per independently approved transfer intent. Do not reuse a key for a second transfer, change the amount under an old key, or create a fresh key just because a request timed out. The key is an identifier, not an authorization secret; the separate `SPONSOR_ADMIN_API_TOKEN` remains confidential.

## Where the key comes from / where to find it

- **When creating a new reservation:** the operator or the local CLI generates the key before calling the API. The successful response includes `reservation.idempotencyKey`.
- **If the request timed out:** the CLI prints the key before making the request and saves a private local recovery record under `~/.trc20-token-studio/reservations/` (or the directory specified by `SPONSOR_RESERVATION_STATE_DIR`). Reuse the exact same key and exact same intent on retry.
- **For an existing reservation:** query the authenticated transfer ledger, `GET /api/tron/sponsorship/transfers?network=nile&limit=100` (or `network=shasta`). Each returned transfer includes its `idempotencyKey`. This endpoint requires `Authorization: Bearer <SPONSOR_ADMIN_API_TOKEN>` and must be called from a trusted operator environment, not embedded in browser code.
- **For the Sponsor Operator Console:** paste the reservation's exact key into its reservation-key field. The console's signing-intent endpoint expects a 24–160 character key. The local CLI generates a key of the correct length.

The key is not obtained from TronScan, TronLink, a transaction hash, Render, or the receiving exchange. Those systems do not issue this application's internal reservation identifier.

## Create a reservation locally

Prerequisites: Node.js, the repository checkout, a configured backend, a previously activated testnet budget, an approved matching sponsor-agreement scope, distinct fee and asset sponsor roles, and fresh sponsor funding snapshots. The API must pass those checks. The command creates an internal testnet reservation only; it never signs or broadcasts.

Set the administrator token in the local shell environment. Do not put it into the frontend, a `VITE_*` variable, a source file, a workflow log, or a committed `.env` file.

Bash:

```bash
export SPONSOR_ADMIN_API_TOKEN='(set this locally without committing it)'
npm run sponsor:reserve -- \
  --network nile \
  --sponsor-reference approved-sponsor-reference \
  --purpose asset-grant \
  --asset USDT \
  --token-contract 'THE_ALLOWLISTED_NILE_TOKEN_CONTRACT' \
  --receiver 'THE_RECEIVER_TRON_ADDRESS' \
  --amount-base-units '1000000'
```

Replace every example value with the exact values from the approved testnet request. Do not assume that the official Mainnet USDT contract is the correct testnet contract. The backend enforces its own token-contract allowlist and address checks. `amount-base-units` must be a positive integer string using the token's verified decimals; do not pass a human-formatted decimal amount.

For a native TRX principal transfer, use `--asset TRX` and omit `--token-contract`. For a separate network-fee reservation, use `--purpose network-fee --asset TRX` with the fee sponsor's already-approved budget scope. Keep fee and principal reservations separate.

The CLI generates a key before the request, prints it, and saves a local recovery record. To retry after a timeout or ambiguous connection result, re-run the same command with the same values and add:

```bash
--idempotency-key 'THE_EXACT_KEY_PRINTED_BY_THE_FIRST_ATTEMPT'
```

Do not rerun a timed-out request with a new key until the protected transfer ledger has been checked. If the helper reports that the same key already exists locally for a different intent, stop; do not overwrite or edit the recovery record.

## Use an existing reservation in the console

1. Call the protected transfer-list endpoint from a trusted operator shell, or locate the key in the CLI output/local recovery record.
2. Confirm the matching network, sponsor reference, purpose, asset, exact token contract, receiver and base-unit amount in the returned record. Do not rely on the key alone.
3. Check that the budget and agreement scope are approved, and that the fee sponsor is separate from the asset-principal sponsor.
4. Open the Sponsor Operator Console at `#/sponsor-operator`, choose the same testnet, connect the **asset-principal sponsor's own wallet**, verify its address, and paste the exact reservation key.
5. Review the entire server-built transaction before the owner signs it. A wallet signature must apply only to that exact transaction; never send private keys or recovery phrases to this application.
6. Only proceed if the deployed backend reports that the route is enabled and fresh fee coverage is verified. If the endpoint says `testnet-signed-broadcast-disabled` or a resource/authorization check fails, stop; do not work around the gate. `pending-review` means an internal reservation exists, not that it has been signed or sent.

## What the states mean

- `pending-review`: an internal budget reservation exists; it is not a transfer.
- `broadcasting`: the database claimed the exact transaction ID before submission; an ambiguous network result must be reconciled, not resent as a different transaction.
- `submitted`: the selected node accepted the transaction ID. It is not proof of block inclusion or receiver credit.
- `confirmed`: only after the backend independently matches solidified chain evidence to the exact network, sender, receiver, amount and token contract.
- `failed` / `cancelled`: inspect the audit state before creating a new independently approved intent.

The reservation CLI intentionally reports `transactionBroadcast: false` for a successful reservation response. It does not create a transaction hash. The chain transaction ID comes from the prepared transaction and must match a real transaction returned by the network node; a successful finalized transfer must then be verified independently.

## Current launch limitation

The code-level testnet signing/broadcast route remains behind `SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED` and the readiness response still fails closed. The helper does not enable that flag, activate sponsor budgets, prove owner consent, produce a wallet signature, submit a transaction, or make a transfer. Do not set the flag to `true` until the documented testnet resource-coverage, authorization, end-to-end transfer, solidification, receiver-balance and sponsor-cost reconciliation gates have passed.
