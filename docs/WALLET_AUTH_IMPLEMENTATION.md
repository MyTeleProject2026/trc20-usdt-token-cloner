# Wallet authentication implementation and deployment checklist

## Current implementation

TRON Token Studio uses wallet ownership proof, not a password derived from a wallet address and not a private-key form.

- **Frontend:** `src/WorkflowApp.tsx` starts the testnet TronLink flow; `src/AuthGate.tsx` protects the workspace and sponsor operator console; `src/MainnetExchangeDeposit.tsx` has a separate Mainnet-only wallet flow for that route.
- **Backend:** `server/routes/tron-wallet-auth.mjs` exposes `POST /api/auth/tron/challenge`, `POST /api/auth/tron/verify`, `GET /api/auth/tron/session`, and `POST /api/auth/tron/logout`, mounted under `/api/auth/tron` in `server/index.mjs`.
- **Persistence:** `server/database.mjs` persists network-scoped wallet accounts, short-lived challenges, and hashed session tokens in PostgreSQL.
- **Tests:** `tests/tron-wallet-auth.test.mjs`, `tests/auth-gate-route.test.mjs`, `tests/wallet-auth-gate.test.mjs`, and `tests/wallet-login-contract-ui.test.mjs` cover one-time challenge verification, replay rejection, session lookup/revocation, frontend route gating, and the absence of private-key collection.

## Login protocol

1. The browser asks TronLink to expose the selected public address.
2. The browser requests a challenge for that address, network, and allowed origin.
3. The server generates a cryptographically random nonce and a message that explicitly says the signature proves wallet control only and authorizes no transfer. PostgreSQL stores a hash of the nonce and message plus the address/network/origin/timestamps—not the raw message.
4. TronLink signs the displayed message using `signMessageV2`. The message signature is not a transaction signature.
5. The browser sends the address, network, nonce, and signature to the server. It does not send the message text as the source of truth.
6. The server consumes the challenge atomically, reconstructs the exact expected message, verifies its stored hash, recovers the signing address, and requires an exact address match.
7. The server creates a 30-minute session. The opaque bearer token is returned to the browser, while only its SHA-256 digest is stored in PostgreSQL.
8. Session restoration verifies the bearer token against the backend. Logout revokes the server-side session. Network/account changes clear identity and stale balance snapshots.

## Render configuration

Backend service: `trc20-usdt-token-cloner-api`.

Required for persistent wallet authentication:
- `DATABASE_URL`: PostgreSQL connection string, configured only in Render's backend environment.
- `FRONTEND_ORIGIN` and/or the additive `OKX_UI_ORIGIN`: the exact HTTPS frontend origin. Current hosted UI: `https://trc20-usdt-token-cloner.onrender.com`.
- `PACKAGED_APP_ORIGINS` only if a packaged client is intentionally enabled. Do not broaden the allowlist to arbitrary origins.

Do not put database credentials, exchange credentials, wallet private keys, or recovery phrases in frontend build variables, source files, GitHub commits, or browser forms.

Set the Render backend **Health Check Path** to `/health` in the service settings. The service's currently inspected Render configuration has this field blank; a live deploy alone does not mean Render is running the health check.

## What wallet login does—and does not do

Wallet login creates a network-scoped account identity after a valid signature. It does not:
- obtain, store, or recover a private key or seed phrase;
- prove ownership of an unrelated exchange account;
- authorize sponsor spending or bypass server-side transfer gates;
- create or change any token balance;
- submit a transfer or guarantee an exchange deposit is credited.

Use the testnet workspace with testnet assets for development that must not require real USDT. Testnet tokens are not mainnet Tether USD.

## Deployment evidence

The inspected `main` commit `c8bd56a9f932f516023b17b007ef0a2839c687b0` had successful GitHub Actions runs for **CI**, **NodeJS build and contract compile**, **Dependency security audit**, and the **Public API smoke and readiness check**. Render's frontend and backend deployments for that commit were reported live. Re-check those services after subsequent commits; a prior successful run does not certify future code changes.
