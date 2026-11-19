# Integrated Tron Transfer Sponsor Wallet

## Product behavior

The Sponsor Wallet is a page inside the existing TRON TRANSFER Owner Admin navigation. It is not a separate application or wallet-creation flow.

The module is import-only:
- private key;
- standard V3 Keystore JSON and its password;
- TRON mnemonic phrase using TronWeb's default TRON BIP-44 derivation path.

There is no Create Wallet action. The imported sponsor account must be different from the configured Owner Wallet:
`TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp`.

The Sponsor Wallet can be locked or logged out without deleting its encrypted local vault. It can be replaced by importing another account; the previous encrypted backup is retained until the replacement import succeeds. Removing the encrypted local backup is a separate, explicitly confirmed action.

## Local wallet vault

- The frontend derives the address and checks it is a valid TRON Base58 address.
- Private-key material is encrypted in the browser with AES-256-GCM.
- The encryption key is derived from the user's local vault password using PBKDF2-SHA256 with 310,000 iterations and a random 16-byte salt.
- The AES-GCM operation uses a fresh random 12-byte IV.
- Only the ciphertext, salt, IV, KDF/cipher metadata and public wallet address are stored in browser local storage.
- The private key is not sent to the API or written to application logs by this module.
- The key is decrypted into browser memory while the wallet is unlocked and used for explicit, user-confirmed Stake 2.0 actions.

This is a local encrypted convenience vault, not a hardware wallet or audited KMS. Browser XSS, malicious extensions, compromised devices and malicious injected scripts remain in-scope threats. Do not use it to control meaningful funds until an independent security review and stronger isolated/hardware-backed signer have been completed. Clearing browser storage removes this local encrypted copy; users must retain their own recovery backup.

## Mainnet observations and actions

The dashboard reads:
- Sponsor Wallet TRX balance;
- official TRON Mainnet USDT balance at `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`;
- Sponsor Wallet Energy and Bandwidth counters;
- the Sponsor Wallet's confirmed Stake 2.0 delegation ceiling for Energy and Bandwidth;
- current delegation state from the Sponsor Wallet to the configured Owner Wallet;
- Owner Wallet Energy and Bandwidth counters.

The dashboard refreshes after import/unlock, on demand, and every 60 seconds while unlocked. Background refreshes do not repeatedly interrupt the operator with success toasts; initial/manual failures remain visible in a centered, dismissible notification. The Automatic Resource Engine has operator-editable Energy and Bandwidth target thresholds and displays live owner-resource deficits. Its default Energy planning threshold is 1,278,524 units and must be replaced with the current deployment preflight estimate before relying on it; this threshold is not a live contract estimate. Background refreshes do not repeatedly interrupt the operator with success toasts; initial/manual failures remain visible in a centered, dismissible notification.

The explicit Stake TRX and Delegate Resource actions construct, sign and broadcast Stake 2.0 transactions from the imported Sponsor Wallet. Each action requires an on-screen confirmation and validates the exact contract type, sponsor address, receiver address, resource type, amount, transaction ID, raw bytes and expiry before asking the imported key to sign. It rejects amounts below 1 TRX and preserves a minimum 1 TRX balance reserve for fees. The reserve is a guard, not a guarantee that every transaction's actual fee can be paid.

A sponsor can delegate only its own eligible Stake 2.0 resources. Incoming delegated resources cannot be re-delegated. The confirmed `getCanDelegatedMaxSize` ceiling is checked before the delegation action. After broadcast, the public transaction ID and expected delegation details can be sent to the backend's rate-limited `/api/tron/sponsorship/resource-delegations/verify-wallet` endpoint. The backend independently checks the solidified transaction and resulting delegation state, then persists only a verified chain fact to the PostgreSQL audit ledger. It accepts no private key, mnemonic, keystore, password or signature. The existing stricter `/verify` endpoint remains restricted to the configured fee-sponsor address.

## Not yet enabled

- Paid Energy/Bandwidth rental or provider purchase: no authorized provider adapter, provider agreement, or provider credentials are configured. The UI shows this as unavailable instead of simulating an acquisition.
- Automatic free Energy/Bandwidth grants: no verified provider grant adapter is configured.
- Unattended automatic signing: intentionally disabled; stake/delegation requires an explicit on-screen confirmation.
- The browser activity timeline stores up to 50 local resource-action records per sponsor address. Independently verified delegations are also synchronized from the server-side PostgreSQL audit ledger; unverified broadcasts are never presented as verified. The ledger endpoint records public on-chain facts only after solidified transaction and resulting delegation-state verification, and applies a per-IP verification request limit. Stake and delegation records are shown; this is not a complete TRX/TRC-20 wallet transaction explorer.
- Production KMS/HSM or hardware-backed signer: not implemented by this browser vault.
- Mainnet deployment readiness: remains controlled by the existing Owner Admin live preflight and zero-TRX-burn gate; importing a Sponsor Wallet does not by itself make deployment ready.

The verification API uses the backend's configured Tatum Mainnet access and database. If either is unavailable, the UI retains a pending local record and refuses to mark the delegation verified. A successful transaction broadcast is not the same as a solidified transaction or independently verified resource allocation. Always refresh and verify Mainnet state before relying on a delegation.
