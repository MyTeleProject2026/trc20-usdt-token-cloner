# Render environment setup: TRON Token Studio sponsor integration

This document describes the current backend configuration for
`MyTeleProject2026/trc20-usdt-token-cloner`. Environment-variable setup can enable
read-only diagnostics; it does **not** activate or authorize a sponsored transfer.

## 1. Open the correct Render service

Open the backend Web Service, not the frontend Static Site:

- Backend: `https://trc20-usdt-token-cloner-api.onrender.com`
- Render dashboard: `https://dashboard.render.com/web/srv-dbanbem1egvs73bcsdkg`

Open **Environment**. Add/edit variables there, then save and let Render deploy/restart.
Do not configure backend secrets as `VITE_*` frontend variables.

## 2. Backend variables

Set values only for resources and agreements the project is authorized to use.

| Variable | Required? | What to configure |
| --- | --- | --- |
| `TATUM_API_KEY` | Required for current Tatum/TRON read-only routes | A valid Tatum API key stored only in Render's backend environment. Never commit it. |
| `TATUM_API_BASE` | Optional | Keep the default `https://api.tatum.io`; the backend only accepts the approved HTTPS Tatum origin. |
| `DATABASE_URL` | Required for persistent history/ledger features | Render PostgreSQL's **Internal Database URL** when services are in the same region/workspace. Never commit the URL. |
| `DATABASE_SSL` | Usually leave `false` for the internal Render connection | Only set `true` if the database endpoint and certificate configuration support the backend's strict TLS validation. Verify readiness after changing it. |
| `FRONTEND_ORIGIN` | Required for browser API requests | Exact frontend origin, for example `https://trc20-usdt-token-cloner.onrender.com` (no path; use comma-separated origins only if intentionally supporting multiple). |
| `TRONGRID_API_KEY` | Optional | A server-side TronGrid API key for routes that explicitly use TronGrid. |
| `TRON_VERIFIED_TOKEN_CONTRACTS` | Optional | Comma-separated additional token contracts accepted by the read-only event verifier after review. This is not a sponsor spend allowlist. |
| `SPONSOR_ADMIN_API_TOKEN` | Required only for privileged sponsor-admin endpoints | Generate a random secret of at least 32 characters, store it only in Render, and provide it only to authorized server-side administrators. Never send it in chat or expose it in the browser. |
| `SPONSOR_APPROVED_AGREEMENT_REFERENCES` | Optional until signed sponsor terms exist | Semicolon-separated reviewed scopes in the exact format described below. Do not add a scope without actual sponsor consent and documented authorization. |
| `SPONSOR_MAINNET_BUDGET_ACTIVATION_ENABLED` | Keep `false` for now | This gate does not enable sponsored transfer submission. Do not set it to `true` as a shortcut for production readiness. |

### Sponsor addresses (public addresses only)

Only monitor addresses whose owners have expressly authorized monitoring. These are not keys
and configuring them does not grant spending authority.

**Optional general read-only snapshot/resource address per network:**
- `SPONSOR_MAINNET_ADDRESS`
- `SPONSOR_SHASTA_ADDRESS`
- `SPONSOR_NILE_ADDRESS`

**Separate role-specific sponsor accounts** (keep fee sponsor and asset-principal sponsor distinct):
- `SPONSOR_FEE_MAINNET_ADDRESS`, `SPONSOR_FEE_SHASTA_ADDRESS`, `SPONSOR_FEE_NILE_ADDRESS`
- `SPONSOR_ASSET_MAINNET_ADDRESS`, `SPONSOR_ASSET_SHASTA_ADDRESS`, `SPONSOR_ASSET_NILE_ADDRESS`

The fee sponsor account is used for fee/resource diagnostics; the asset sponsor is the candidate
source of actual transfer principal. Fresh balances do not prove permission to spend. Production
sponsorship still needs signed consent/mandate, a secure authorized signer or provider submitter,
spend limits, atomic reservations, idempotency/reconciliation, and independent solidified-chain
verification. Neither address variables nor an admin token enable submission.

### Token contracts

Mainnet official USDT is fixed in the backend to Tether's TRON contract
`TR7NHqjeKQxGTCi8q8ZY4p8L8otSzgjLj6t`. For test networks or project token contracts, set only
the explicitly reviewed network-specific allowlists:

- `SPONSOR_USDT_SHASTA_CONTRACTS`
- `SPONSOR_USDT_NILE_CONTRACTS`
- `SPONSOR_VTRC_MAINNET_CONTRACTS`
- `SPONSOR_VTRC_SHASTA_CONTRACTS`
- `SPONSOR_VTRC_NILE_CONTRACTS`

Use comma-separated contract addresses in the expected TRON address format. Do not assume a testnet
contract is mainnet USDT. `VTRC` is a separate project token and must not be represented as official USDT.

### GasFree provider credentials (optional, read-only integration only)

Apply to GasFree and obtain credentials from the provider before filling these in:

- `GASFREE_MAINNET_API_KEY`
- `GASFREE_MAINNET_API_SECRET`
- `GASFREE_NILE_API_KEY`
- `GASFREE_NILE_API_SECRET`

Keep the key/secret server-side in Render. The current repository integration is provider discovery,
account metadata and trace verification; it is not a live sponsored submit/sign/broadcast adapter.
GasFree's published fee schedule charges activation/transfer fees in the transferred token, so it
does **not** satisfy a policy that promises users pay neither principal nor any fee by itself.
Do not describe it as a free asset-principal sponsor.

## 3. Agreement scope format

Only after the sponsor has actually signed/approved the arrangement, add a semicolon-separated item
to `SPONSOR_APPROVED_AGREEMENT_REFERENCES` in this exact format:

`reference|sponsorReference|network|sponsorAddress|purpose|asset|tokenContract`

Use network `mainnet`, `shasta`, or `nile`; purposes are restricted by the application to its configured
sponsorship scopes. Use `-` for `tokenContract` on TRX budgets. Keep the approval reference traceable
to the signed agreement. Do not place private keys, passwords, API secrets, recovery phrases, or
wallet signing material in this variable.

## 4. Verify configuration after saving

Run these read-only checks after the backend restarts:

1. `GET /health` — confirms the web service responds.
2. `GET /api/readiness` — checks the database and authenticated read-only Tatum request.
3. `GET /api/tron/sponsorship/status` — must honestly show sponsorship unavailable/disabled until the real adapter and approvals exist.
4. `GET /api/tron/sponsorship/integration-readiness` — reports configured-variable/address-format booleans and performs read-only GasFree provider-discovery probes for Mainnet and Nile when credentials are configured. It never returns secrets or sponsor addresses; provider reachability does not prove funding or authorization. Shasta is unsupported by this adapter. It must remain `preflight-only-not-production-ready` with submission disabled. Probes are deduplicated and cached for 15 seconds per API process.
5. `GET /api/tron/sponsorship/roles?network=nile&refresh=1` — reads two role-specific sponsor-account diagnostics, if both addresses are configured.
6. `GET /api/gasfree/config-status` — reports credential presence only.
7. `GET /api/gasfree/capabilities?network=nile` — when credentials are present, tests documented provider discovery; this is not funding or send authorization.

A 200 response from a status/readiness/capabilities route is not evidence of a sponsored transfer.
Never submit a mainnet transaction as a configuration test. First pass automated CI, then conduct
an approved Nile testnet end-to-end test using controlled test assets and a signer designed for
the integration. Retain sanitized transaction IDs and independently verify the solidified receipt,
exact recipient amount, fee behavior, duplicate-request handling, and timeout reconciliation.

## 5. Provider research decision

Official GasFree documentation describes provider-paid on-chain gas for a signed TRC-20 transfer,
but its token configuration describes activation/transfer fees paid in the transferred token.
Official TRON tooling documents the same token-denominated fee behavior. These are not free transfers
of principal, and the current backend is not a GasFree submitter.

Other public energy-rental/relay services surfaced during research also charge a fee or require a
signed sender payment for energy. They do not provide a verified public pool that pays both the
requested USDT/TRX principal and all transaction costs. The implementation must therefore use the
two-model design (a contracted provider, and separately authorized sponsor organizations) without
pretending a sponsor exists. The sponsor organization route needs actual organizations, funding, and
a secure signing service. No environment variable can create those real-world prerequisites.

References:
- GasFree official docs: https://docs.gasfree.io/
- TRON developer hub: https://developers.tron.network/docs/bandwidth-and-energy
- TronTransfer service docs (illustrates sender-paid fee model, not selected as a no-cost sponsor): https://doc.trontransfer.com/
