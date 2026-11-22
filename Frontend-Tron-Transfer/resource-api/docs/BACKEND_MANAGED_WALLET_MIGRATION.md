# Backend-managed Owner and Sponsor wallet migration

This implementation increment establishes a safe identity-discovery foundation for the existing Tron Transfer Resource API. It does not claim that password authentication or server-side Owner signing is complete.

## Existing Render configuration

- `TRON_OWNER_PRIVATE_KEY` — Owner private key, backend only.
- `TRON_OWNER_ADDRESS` (or existing `TRON_OWNER_WALLET_ADDRESS`) — expected Owner Mainnet address.
- `SPONSOR_MAINNET_PRIVATE_KEY` — Sponsor private key, backend only.
- `SPONSOR_MAINNET_ADDRESS` — expected Sponsor Mainnet address.

The API derives both addresses with TronWeb and checks exact matches and identity separation. It never returns either private key. The new read-only endpoint is:

`GET /api/wallets/managed-identities`

The endpoint returns public addresses, match/readiness flags, and `executionEnabled: false`. It does not create password accounts, sign transactions, or enable broadcasting.

## Required next increments before Option A is complete

1. **Protected first-owner enrollment:** select and implement a secure bootstrap trust anchor. A publicly accessible API cannot safely let the first visitor claim Owner merely by choosing a password. Do not use the Owner private key itself as an HTTP credential or expose it to the browser. Prefer an operator-controlled, one-time enrollment approval with expiry, single-use consumption, audit event, and immediate disablement after setup.
2. **Persistent password accounts:** store salted, memory-hard password verifiers (Argon2id preferred; scrypt with calibrated parameters if the existing dependency policy requires Node built-ins) in the production database. Never store plaintext passwords or reversible password encryption.
3. **Independent sessions and roles:** separate Owner and Sponsor session audiences, short expiry, rotation/revocation, CSRF protection for cookie sessions, rate limiting, and audit trails. Owner authorization may administer Sponsor policy but must not collapse the two signing identities.
4. **Backend-only signing:** implement dedicated Owner and Sponsor signer adapters. Bind each adapter to its own key and allowlisted operations; never accept a caller-supplied private key, signer address, arbitrary transaction payload, or arbitrary contract target. Sponsor exact-intent/idempotency/ledger safeguards remain in force.
5. **Migrate Owner transaction call sites:** move every Owner contract deployment, mint, pause, transfer, ownership, and resource transaction path to a server-prepared unsigned transaction plus authenticated server-side signing, or another explicitly reviewed server custody design. No browser private key may remain as an alternate fallback after cutover.
6. **Remove frontend secret entry:** remove Sponsor Admin token UI and private-key import UI only after the replacement auth/signing paths are deployed and tested. Keep all environment variables server-side.
7. **Acceptance:** test password enrollment, brute-force throttling, session revocation, Owner/Sponsor separation, address derivation mismatch, key non-disclosure in all responses/logs/bundles, transaction intent restrictions, idempotency, restart recovery, and Mainnet broadcast disabled.

## Safety

The identity report is diagnostic only. The endpoint always reports execution disabled. Do not enable `SPONSOR_TRANSACTION_ENGINE_ENABLED` or `SPONSOR_MAINNET_BROADCAST_ENABLED` as a consequence of this PR. The Owner and Sponsor private keys must never be copied into frontend environment variables, browser storage, logs, screenshots, GitHub issues, or chat.
