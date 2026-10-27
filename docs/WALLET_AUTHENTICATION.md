# TRON wallet identity authentication

## Purpose and boundary

This app uses a wallet-owned message signature as proof of control of a public TRON address. It never requests, accepts, uploads, logs, or stores wallet private keys, seed phrases, or recovery phrases. A login signature is a message signature, not a blockchain transaction.

A successful login provisions or updates a network-scoped public wallet account record in PostgreSQL and creates a 30-minute session. It does not authorize sponsor spending, grant exchange-account access, create token balances, or submit transactions.

The wallet identity endpoint now supports **TRON Mainnet, Nile testnet, and Shasta testnet**. The transfer workspace remains testnet-only; Mainnet deposit flow is a separate page and still requires explicit wallet confirmation for every transaction.

## Authentication protocol

1. The client asks TronLink to connect and obtains the active Base58 address.
2. The client confirms the active TronLink RPC node matches the page's intended network.
3. The client requests `POST /api/auth/tron/challenge` with `address` and `network`. The server checks the request origin against its exact allowlist, generates a random nonce, constructs a message bound to address, network, origin, issue time and expiry, and stores only a SHA-256 digest of the nonce plus the necessary public metadata and timestamps. The raw nonce and complete signed message are not persisted.
4. TronLink signs the human-readable message with `signMessageV2`. No transaction is built by the login action.
5. The client submits the exact address, network, nonce, signed message and signature to `POST /api/auth/tron/verify`. The server atomically marks the one-use challenge as consumed, reconstructs the expected message from stored metadata and the submitted nonce, rejects any mismatch, and verifies the signature against that reconstructed message. Replay attempts fail. Challenge issuance is capped at eight requests per wallet/network/origin in five minutes and returns `429` with `Retry-After` when capped.
6. After successful signature verification, PostgreSQL records the network-scoped public wallet account and the hash of a randomly generated bearer token. The raw bearer token is returned once to the client and held in tab-scoped `sessionStorage`; it is not stored in localStorage.
7. `GET /api/auth/tron/session` verifies the token digest, allowed origin, and session expiry on every restore and before a Mainnet send. `POST /api/auth/tron/logout` revokes that session.

## Stored data

The project schema `trc20_token_clone` contains:

- `wallet_auth_accounts`: network and public wallet address, with first-authenticated and last-authenticated timestamps.
- `wallet_auth_challenges`: one-time nonce hash, public address, network, origin, issued/expiry timestamps, and consumed timestamp. The raw nonce and signed message are not stored. Consumed rows remain until expiry so repeated challenges cannot evade rate limiting; expired rows are removed during issuance.
- `wallet_auth_sessions`: SHA-256 token hash, address/network/origin, and expiry. Raw session bearer tokens are never persisted.

These are application identity records only. They are not a custodial wallet and do not contain signing material.

## Render configuration

The existing backend Web Service needs:
- PostgreSQL configured through `DATABASE_URL` (the schema migrations execute at startup).
- `FRONTEND_ORIGIN`, `PACKAGED_APP_ORIGINS`, or the additive `OKX_UI_ORIGIN` set to an exact approved frontend origin. The current hosted UI origin is `https://trc20-usdt-token-cloner.onrender.com`.
- Health Check Path set to `/health` in the Render dashboard.

Do not store private keys or seed phrases in Render environment variables. Tatum/TronGrid API keys are provider credentials and are not wallet sign-in credentials.

## Important limitations

- A signed login proves control of a public address at the time of signing. It does not prove that the user owns an exchange account associated with that address.
- A wallet login does not prove that a transaction exists, that a transfer settled, or that an exchange credited a deposit.
- Mainnet identity is separated from the testnet transfer workspace. The wallet signature itself does not grant transfer authorization; each actual transaction requires a separate wallet transaction confirmation and its own verification.
- Session tokens are bearer credentials. Do not share them or place them in URLs, screenshots, source code, or issue reports.
- The route fails closed if PostgreSQL persistence is not available; it does not fall back to per-process in-memory sessions that would disappear after a restart or diverge across service instances.

## Verification

Run `npm ci`, `npm test`, and `npm run build`. Authentication tests use a test-only injected store and a fake signature-recovery function; they validate routing and protocol behavior, but they do not replace a real TronLink/browser test or a production PostgreSQL migration check.
