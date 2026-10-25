# Sponsor-owned TRON testnet signing and broadcast

## What was added

The sponsor operator console is available from the frontend route #/sponsor-operator. It connects a sponsor-owned TronLink wallet, verifies the injected node host is exactly Shasta or Nile, retrieves a server-created signing intent, checks that the connected account equals the approved asset-principal sponsor address, asks the sponsor wallet to sign, and posts only the signed transaction back to the backend.

Backend routes:

- GET /api/tron/sponsorship/transfers/:idempotencyKey/signing-intent
- POST /api/tron/sponsorship/transfers/:idempotencyKey/submit-signed

The server supports native TRX and allowlisted TRC-20 asset grants for Shasta/Nile only. It stores the exact unsigned transaction and its transaction ID in the database before returning it for wallet signing. Submission requires the returned signed transaction to match that saved signing intent, checks the selected node's signature permission, rechecks current sponsor resource capacity and role separation, locks the reservation to one transaction ID before broadcast, and marks it submitted only after the same fixed network node accepts the exact ID.

The console never asks for or sends a wallet private key, seed phrase, or recovery phrase. The backend does not store a sponsor signing key.

## Backend environment

In Render's backend Web Service only, use the following values as an example. The broadcast flag intentionally defaults to false:

    SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED=false
    SPONSOR_TESTNET_MAX_FEE_LIMIT_SUN=50000000

The first variable is the route-level opt-in for this testnet-only operation. Do not enable it merely because the frontend console appears or because a balance endpoint reports a value. Before testnet operator testing, the applicable Shasta/Nile fee and asset sponsor addresses must be configured and distinct, a funded testnet budget must be approved against a real sponsor agreement scope, the sponsor must sign the exact intent, and the fee sponsor's resource delegation and recipient capacity checks must be readable. Keep the setting unset/false unless an operator intentionally authorizes a controlled testnet experiment. Never create VITE_* signing-secret variables and never paste wallet keys into Render.

TRONGRID_API_KEY is optional and server-only; the endpoints use fixed Shasta/Nile hosts irrespective of browser input. A Tatum API key supports existing read-only balance/delegation checks and is not a signing key.

## Exact state machine and safe retry behavior

1. A budget reservation remains pending-review until the sponsor's own wallet signs the exact transaction built by the server.
2. The unsigned transaction is durably persisted before it is returned. Requests for the same reservation reuse the same saved bytes and transaction ID.
3. The server checks the transaction's raw bytes and ID against that stored intent and asks the selected network node to validate signature permission. It also checks current sponsor resource capacity before broadcast.
4. Before sending the transaction, the database row is locked and bound to the exact transaction ID as broadcasting. That prevents a different transaction from replacing it in a race.
5. The server marks it submitted only when the fixed Shasta/Nile node explicitly accepts the same transaction ID. A network timeout or failed response is ambiguous; the reservation is retained and must not be replaced by a different transaction.
6. submitted means node acceptance only. It is not evidence of block inclusion, solidification, successful TRC-20 execution, actual fee consumption, recipient balance, or exchange deposit credit.

## Current limitations

- This route does not send Mainnet transactions. The global production readiness response remains enabled=false and canSubmitSponsoredTransfer=false.
- Resource availability and a visible delegation are preflight evidence, not final fee settlement. The separate fee-resource budget ledger and after-confirmation expense reconciliation remain unfinished.
- No full supported Shasta/Nile end-to-end run, security approval, dependency-audit clearance, or production sponsor agreement has been recorded.
- GitHub Actions hosted runners have recently failed before checkout (runner allocation, no steps), so the full repository test/build/audit suite has not yet completed on CI.
- Do not merge or deploy this PR as a production-ready sponsor sender until the go-live checklist is closed.

See SPONSOR_GO_LIVE_GATES.md for the release decision list.
