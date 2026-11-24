# Sponsor Wallet Mainnet go-live gates

## Scope

This checklist applies only to the integrated Sponsor workspace inside the existing Tron Transfer Owner Admin application. It covers Sponsor-owned TRX/resource operations and the direct Sponsor-to-Owner resource/funding relationship. It is not a USDT payout, provider-credit, exchange-deposit, or third-party sponsorship workflow.

## Required architecture

- The Owner and Sponsor are distinct TRON Mainnet wallets, independently enrolled and independently unlocked.
- Sponsor private-key material stays in the encrypted local Sponsor vault. The Resource API receives only the exact signed transaction and public metadata.
- Sponsor signs only Sponsor-owned operations. Owner signs only Owner-owned TRӾ contract operations.
- Tatum is the preferred read-only Mainnet RPC provider; TronGrid is the read fallback and signed-transaction broadcast/history path.
- Neon is the existing persistent database. Render hosts the existing frontend and Resource API services.
- No backend signer, external Sponsor, third-party resource provider, GasFree, TEnergy, WDK, Fincra, Fireblocks, external treasury, or payout route is permitted.

## Code and data acceptance

1. **Identity isolation**
   - Confirm the configured Owner and Sponsor addresses are valid Mainnet addresses and distinct.
   - Confirm each authenticated session maps to the correct wallet role.
   - Confirm Sponsor cannot invoke Owner operations and Owner cannot sign Sponsor operations.
2. **Local custody**
   - Import and unlock each existing wallet independently.
   - Verify private keys, mnemonic phrases and keystore passwords never appear in API requests, database rows, logs or browser network payloads.
   - Verify lock/logout clears the active signer and revokes the matching application session.
3. **Sponsor operations**
   - Prepare and locally sign TRX staking and unstaking.
   - Prepare and locally sign matured unfreeze withdrawal.
   - Prepare and locally sign Energy/Bandwidth delegation to the configured Owner.
   - Prepare and locally sign undelegation.
   - Prepare and locally sign explicit TRX top-up to Owner.
   - Verify exact amount, recipient, resource type, permission, balance and fee/resource preflight for each operation.
4. **Transaction reliability**
   - Persist the operation intent and idempotency key before returning an unsigned transaction.
   - Verify exact signed bytes and recovered Sponsor signer before broadcast.
   - Persist the signed payload and transaction ID before one TronGrid broadcast attempt.
   - Reconcile the original transaction ID against solidified Mainnet state.
   - Prove duplicate requests do not create duplicate operations and ambiguous outcomes are not automatically re-signed or rebroadcast.
5. **Neon production readiness**
   - Verify the runtime database URL fingerprint matches the approved existing Neon database.
   - Verify the Sponsor operations table, required columns, indexes, constraints and paused control row.
   - Complete authenticated Owner-session and CSRF-protected Sponsor ledger bootstrap only after backup/restore and rollback checks.
   - Keep Sponsor writes paused until independent acceptance is complete.
6. **Browser acceptance**
   - Complete desktop and mobile tests for Owner and Sponsor import, unlock, lock, session recovery, signing, transaction history, errors and interrupted network outcomes.
   - Do not use a real-value Mainnet transfer as a test.
7. **Operational acceptance**
   - Verify health/readiness, provider fallback, TronGrid-only broadcast, audit history, rate limiting, monitoring, backup/restore and emergency pause.
   - Confirm no private-key environment variable or server-side signing path remains.

## Activation rule

Passing CI is necessary but not sufficient. Keep Sponsor writes and Owner deployment execution disabled until independent security review and all acceptance evidence are complete. Enable each execution gate only with explicit operator authorization.

Sponsor funding and resource arrangements are treated as already prepared. These gates verify the application and actual current Mainnet state; they do not require sourcing another Sponsor, resource provider, Energy, Bandwidth or fee arrangement.
