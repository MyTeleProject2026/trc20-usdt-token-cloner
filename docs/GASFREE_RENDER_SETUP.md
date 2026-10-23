# GasFree Render environment setup

This guide applies to the backend Web Service only. Do not put any GasFree API secret in the frontend Static Site, browser code, source control, issue comments, screenshots, or API responses.

## Current implementation boundary

The current GasFree adapter is **read-only**: it can check credential presence and, when valid credentials are configured, query GasFree provider/token discovery, account metadata, and provider trace status. It does not construct or sign a transfer authorization, submit a transfer, or enable sponsored transfers. The backend intentionally returns `canSubmitSponsoredTransfer: false` and `submissionEnabled: false`.

GasFree's published specification says activation and transfer fees are charged in the transferred token. Therefore GasFree must not be described as a free sponsor or as a source of the sender's USDT/TRX principal. Provider discovery and a successful API response do not prove a provider is funded or agrees to pay fees for this application.

Only use the verified official TRON token contract for a real USDT transfer. The project's independent VTRC token must never be represented as official USDT. A confirmed on-chain transfer does not guarantee that a centralized exchange will credit a deposit; the receiving exchange's deposit rules and confirmations still apply.

## Environment variables

Add values in the Render **backend Web Service** environment settings, then trigger/rely on the service's normal redeploy. Do not add these values to the Static Site.

| Variable | Required? | Purpose |
| --- | --- | --- |
| `GASFREE_MAINNET_API_KEY` | Only when using signed Mainnet API access | GasFree Developer Center API key for TRON Mainnet |
| `GASFREE_MAINNET_API_SECRET` | Paired with the Mainnet key | Server-only HMAC secret; never expose it |
| `GASFREE_NILE_API_KEY` | Only when using signed Nile API access | GasFree testnet API key |
| `GASFREE_NILE_API_SECRET` | Paired with the Nile key | Server-only testnet HMAC secret |
| `TATUM_API_KEY` | Already used by existing Tatum read-only endpoints | Existing Tatum read-only API access |
| `TRONGRID_API_KEY` | Optional, depending on rate limits | TRONGrid read-only history/balance queries |
| `DATABASE_URL` | Required for persistent receiver history/ledger features | Render PostgreSQL connection string |
| `FRONTEND_ORIGIN` | Required for browser API access | Exact allowed frontend origin(s), comma-separated |
| `RECEIVER_WATCHLIST_ADMIN_TOKEN` | Optional; only if using protected wallet registration | Long random server-only token of at least 32 characters |

The current adapter uses the four network-specific GasFree variable names above. Mainnet and Nile credentials are separate. Do not paste actual values into GitHub or this document. If GasFree tells your account that a specific provider permits unsigned requests, the current adapter still expects a key/secret pair and would need an intentional, reviewed code change before unsigned access could be used.

## How to add them safely

1. Open the Render dashboard and select the backend Web Service for this repository.
2. Open its Environment settings.
3. Add the GasFree variable names exactly as shown above, using values issued by GasFree for the corresponding environment. Keep Mainnet credentials separate from Nile testnet credentials.
4. Save and allow Render to redeploy the backend.
5. Call `GET /api/gasfree/config-status`. It should show only configured/missing status; it must never return a key or secret.
6. Call `GET /api/gasfree/capabilities?network=nile` first to test read-only provider/token discovery. Use `network=mainnet` only after Mainnet access has been approved. A provider-auth rejection means the credentials/access are not accepted; do not work around provider authentication.
7. Confirm that the response still says transfer submission is disabled. Do not interpret provider reachability as proof of sponsor funding.

## Not currently available

- No production transfer submission through GasFree.
- No verified external sponsor agreement or funded sponsor account.
- No proof of zero-fee Mainnet transfers.
- No sponsor-funded USDT/TRX principal or user-funded fallback.
- No automatic guarantee of exchange deposit credit or receiver-wallet notifications outside this application.

Before any transfer-submission implementation is considered, the project needs a reviewed authorization/signing flow, exact official token-contract allowlist, server-side authorization and replay/nonce protections, idempotent reservation and reconciliation, solidified transaction/receipt and token-event verification, limits and emergency pause, and an end-to-end Nile test. Mainnet activation requires explicit operator approval and a separately verified sponsor/fee policy.
