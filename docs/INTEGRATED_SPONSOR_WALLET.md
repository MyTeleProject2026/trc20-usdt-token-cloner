# Integrated Tron Transfer Sponsor Wallet

## Product behavior

The Sponsor Wallet is a page inside the existing TRON TRANSFER Owner Admin navigation. It is not a separate application or wallet-creation flow.

The module is import-only:
- private key;
- standard V3 Keystore JSON and its password;
- TRON mnemonic phrase using TronWeb's default TRON BIP-44 derivation path.

There is no Create Wallet action. The imported sponsor account must be different from the configured Owner Wallet:
`TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp`.

Lock returns to the encrypted-wallet unlock prompt. Logout clears the active session and returns to the import screen while retaining the encrypted backup; a separate Reconnect saved Sponsor Wallet action restores the unlock prompt. Neither action deletes the vault. The wallet can be replaced by importing another account; the previous encrypted backup is retained until the replacement import succeeds. Removing the encrypted local backup is a separate, explicitly confirmed action.

## Local wallet vault

- The frontend derives the address and checks it is a valid TRON Base58 address.
- Private-key material is encrypted in the browser with AES-256-GCM.
- The encryption key is derived from the user's local vault password using PBKDF2-SHA256 with 310,000 iterations and a random 16-byte salt.
- The AES-GCM operation uses a fresh random 12-byte IV.
- Only the ciphertext, salt, IV, KDF/cipher metadata and public wallet address are stored in browser local storage.
- The private key is not sent to the API or written to application logs by this module. The API receives only the exact locally signed transaction payload and its public transaction metadata.
- The key is decrypted into browser memory while the wallet is unlocked and used for explicit, user-confirmed Stake 2.0 actions.

This is a local encrypted convenience vault, not a hardware wallet or audited KMS. Browser XSS, malicious extensions, compromised devices and malicious injected scripts remain in-scope threats. Do not use it to control meaningful funds until an independent security review and stronger isolated/hardware-backed signer have been completed. Clearing browser storage removes this local encrypted copy; users must retain their own recovery backup.

## Resource API signing lifecycle

The integrated Sponsor workspace uses the following Resource API lifecycle:

- `POST /api/sponsor/operations/prepare`: consumes a short-lived, owner-authorized operation intent; checks the durable write-pause gate; reserves the idempotency key; prepares the exact unsigned transaction; and persists it before returning it to the browser.
- The browser's unlocked Sponsor vault calls `signSponsorTransaction` locally. It verifies the Sponsor owner address, transaction integrity, expiry, contract type and exact operation intent. The API never receives the private key or vault password.
- `POST /api/sponsor/operations/submit`: accepts only the matching prepared transaction and one local signature; verifies transaction integrity, recovers the Sponsor signer, checks TRON permission threshold and repeats current balance/resource/fee checks. The signed payload and transaction ID are committed before the API attempts broadcast.
- `POST /api/sponsor/operations/cancel`: cancels only a reserved operation that has not been signed or broadcast. It cannot cancel a signed or ambiguous transaction.
- `GET /api/sponsor/operations/:reference`: reconciles the persisted transaction ID against Mainnet. An unsigned preparation that expires is marked failed; a signed or ambiguous transaction is never replaced with a new transaction automatically.

The former one-step server-signer route is disabled. A legacy remote-signer adapter module was removed because no HSM/KMS service or signer key handle was provisioned. The active workflow is local Sponsor vault signing followed by backend signature verification and controlled broadcast.

## Sponsor session lock policy

The Sponsor Wallet automatically clears its in-memory signing session after five minutes without pointer, keyboard, touch, or scroll activity. If the page remains hidden/backgrounded for 60 seconds, the session is locked sooner. Returning to the page before that background timeout cancels the background lock and restarts the idle timer. Manual Lock uses the same cleanup path. These actions clear the active wallet object, resource/transaction snapshots, and credential form state while retaining the encrypted local vault for an explicit unlock. This reduces the time that signing material remains reachable through the active application state; it does not protect against an active XSS payload, malicious browser extension, compromised device, or memory inspection while the session is unlocked.

## Mainnet observations and actions

The dashboard reads:
- Sponsor and Owner resource snapshots through the existing TRON Transfer Resource API (Tatum first, TronGrid fallback), with direct TronWeb fallback if that service is unavailable;
- up to 20 recent confirmed native Sponsor Wallet transactions and official USDT transfers from the Resource API's TronGrid history endpoint (not the deprecated TronWeb related-transaction API);
- Sponsor Wallet TRX balance;
- official TRON Mainnet USDT balance at `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`;
- Sponsor Wallet Energy and Bandwidth counters;
- the Sponsor Wallet's confirmed Stake 2.0 delegation ceiling for Energy and Bandwidth;
- current delegation state from the Sponsor Wallet to the configured Owner Wallet;
- Owner Wallet Energy and Bandwidth counters.

The dashboard refreshes after import/unlock, on demand, and every 60 seconds while unlocked. Background refreshes do not repeatedly interrupt the operator with success toasts; initial/manual failures remain visible in a centered, dismissible notification. The Automatic Resource Engine has operator-editable, browser-persisted Energy and Bandwidth target thresholds, displays live owner-resource deficits, and sends transition-based shortfall/recovery notifications without repeating alerts on every background poll. A Run Resource Preflight action performs an immediate refresh. It estimates the sponsor TRX stake needed to cover each deficit using the node's current network-wide resource limit/weight ratios and offers a one-click amount prefill; the operator still separately confirms the Stake 2.0 transaction. Its default Energy planning threshold is 1,278,524 units and must be replaced with the current deployment preflight estimate before relying on it; this threshold is not a live contract estimate. Background refreshes do not repeatedly interrupt the operator with success toasts; initial/manual failures remain visible in a centered, dismissible notification.

USDT is displayed as a capital balance only; Stake 2.0 requires TRX. The module does not swap USDT automatically, and USDT alone does not create Energy or Bandwidth. The Resource API constructs and durably reserves the exact unsigned Stake 2.0, delegation, undelegation, unstake, matured-withdrawal or Sponsor-to-Owner top-up transaction. The imported Sponsor vault checks the transaction type, Sponsor owner address, recipient, resource, amount, transaction ID, protobuf bytes and expiry, then signs locally only after a separate on-screen confirmation. The client returns the signed payload to the API; it does not broadcast. The API independently recovers the signer, checks TRON permission weight, rechecks balance, Bandwidth, fee cap and operation-specific resource state, persists the signed payload and transaction ID, then attempts one broadcast and reconciles the same transaction against solidified Mainnet state. It rejects amounts below 1 TRX for stake/delegation lifecycle operations and preserves the configured liquid TRX reserve. The reserve is a guard, not a guarantee that every transaction's actual fee can be paid.

A sponsor can delegate only its own eligible Stake 2.0 resources. Incoming delegated resources cannot be re-delegated. The confirmed `getCanDelegatedMaxSize` ceiling is checked before the delegation action. After broadcast, the public transaction ID and expected delegation details can be sent to the backend's rate-limited `/api/tron/sponsorship/resource-delegations/verify-wallet` endpoint. The backend independently checks the solidified transaction and resulting delegation state, then persists only a verified chain fact to the PostgreSQL audit ledger. It accepts no private key, mnemonic, keystore, password or signature. The existing stricter `/verify` endpoint remains restricted to the configured fee-sponsor address.

## Release gates and not-yet-enabled capabilities

- The local Sponsor prepare/sign/verify/persist/broadcast/reconcile protocol is implemented and covered by tests. It is not enabled for production execution: Sponsor writes remain paused and the explicit Mainnet execution flags, production database acceptance, backup/restore evidence and independent security review must all pass first.
- The production Sponsor operations schema has not been bootstrapped or accepted. No Mainnet Sponsor transaction was signed or broadcast during implementation.

- Paid Energy/Bandwidth rental or provider purchase: no authorized provider adapter, provider agreement, or provider credentials are configured. The UI shows this as unavailable instead of simulating an acquisition.
- Automatic free Energy/Bandwidth grants: no verified provider grant adapter is configured.
- Unattended automatic signing: intentionally disabled; stake/delegation requires an explicit on-screen confirmation.
- The browser activity timeline stores up to 50 local resource-action records per sponsor address. The local Security Events timeline records imports, unlocks, locks, logouts, replacement, resource broadcasts, verification and local-backup removal without storing credentials. Independently verified delegations are also synchronized from the server-side PostgreSQL audit ledger; unverified broadcasts are never presented as verified. The ledger endpoint records public on-chain facts only after solidified transaction and resulting delegation-state verification, and applies a per-IP verification request limit. Stake and delegation records are shown; the node history is limited to the latest 20 confirmed related transactions and is not a full archive or complete TRC-20 event index.
- Production KMS/HSM or hardware-backed signer: not implemented by this browser vault.
- Mainnet deployment readiness: remains controlled by the existing Owner Admin live preflight and zero-TRX-burn gate; importing a Sponsor Wallet does not by itself make deployment ready.

The verification API uses the backend's configured Tatum Mainnet access and database. If either is unavailable, the UI retains a pending local record and refuses to mark the delegation verified. A successful transaction broadcast is not the same as a solidified transaction or independently verified resource allocation. Always refresh and verify Mainnet state before relying on a delegation.
