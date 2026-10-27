# TRON Token Studio local wallet vault

## What this screen does

Open `#/wallet` in the web app or bundled Capacitor Android app. The Wallet Vault can:

- Generate a real secp256k1 TRON keypair with TronWeb on-device.
- Import an existing 64-hex-character private key locally and encrypt it before saving.
- Restore a TRON Token Studio encrypted JSON backup.
- Keep multiple encrypted wallet records on that browser/device.
- Unlock/lock a selected key in application memory.
- Read native TRX balance from the selected public TRON RPC endpoint and read `balanceOf`, `decimals`, `symbol`, `name` and `totalSupply` for user-selected TRC-20 contracts.
- Review and locally sign real native TRX or TRC-20 transfers, broadcast signed transactions to the selected public TRON node, save transaction IDs locally, and refresh transaction status from full/solidified-node reads.
- Check Mainnet contract source-verification and risk annotations through the read-only TronScan API; verification status is evidence, not a guarantee of legitimacy.
- Sign the backend's one-time identity challenge to obtain the existing testnet workspace session.

Wallet generation does not activate an account on-chain. A newly generated address initially has no assets until it is used on a network. Mainnet and testnet addresses derive from the same key, but their balances and transactions are separate.

## Key protection and limitations

The current keystore uses PBKDF2-HMAC-SHA-256 (600,000 iterations for new records) to derive an AES-256-GCM encryption key, with a unique 16-byte salt, 12-byte IV and address-bound additional authenticated data. Existing records created with the earlier 310,000 iteration version remain decryptable. Only the encrypted record is stored in localStorage; the private key is kept in transient component state while unlocked and is not sent to the backend.

**This is a client-side password-encrypted web wallet, not a hardware wallet or an audited mobile secure-keystore implementation.** A compromised device, malicious browser extension, injected script, or compromised app build could access a key while it is unlocked. Local storage can be cleared by the browser/OS. Use the encrypted backup, keep it private, and test recovery before depending on it. A lost password cannot be reset by the server. Do not treat the current implementation as ready to custody substantial mainnet assets without independent wallet-security review and real-device testing.

This build does not generate a BIP-39 mnemonic/recovery phrase. The recovery path provided by this iteration is the app-specific encrypted JSON backup plus its password. Real TRX and TRC-20 transfer controls are available after an explicit review, local signing and signed-transaction broadcast. The wallet has not undergone an independent security audit. Transfers must be treated as irreversible.

## Network and contract reads

- Nile, Shasta and Mainnet are selected independently; switching the network does not switch a key's identity.
- Native TRX balance comes from TronWeb's read-only `getBalance` call.
- The token watchlist calls real read-only contract methods. Mainnet source/risk annotations come from TronScan's public API; testnet source-verification evidence remains unknown rather than being borrowed from Mainnet.
- Mainnet TRC-20 transfers are blocked unless the contract matches the official Tether TRON USDT address under additional on-chain metadata checks, or TronScan reports fully verified source with no risk markers. Source verification is not a guarantee of safety, issuer identity, liquidity, peg or value.
- Native TRX transfers and supported TRC-20 transfers are signed locally and broadcast to the selected public node. The app checks balances, simulates TRC-20 calls, estimates a fee cap, requires explicit review and acknowledgement, and requires typing `SEND MAINNET` before Mainnet broadcast.
- The transaction ID is read back from the network; a transaction is only labeled confirmed when a successful execution receipt is available. An explicit failed receipt wins over conflicting success-shaped metadata; ambiguous receipts remain unresolved. Local history is an activity aid, not a ledger guarantee, and exchange credit remains dependent on the recipient exchange's authenticated deposit record.

## Workspace authentication

For Nile/Shasta, **Sign in to workspace** requests a challenge from `POST /api/auth/tron/challenge`, signs only that human-readable message locally with `signMessageV2`, then sends only the public address, selected network, nonce and signature to `POST /api/auth/tron/verify`. The private key is not included in the HTTP payload. This creates a wallet-identity session; it does not authorize sponsor spending, exchange access or a token transfer. The current main workspace gate is testnet-only.

The deployed API must allow the exact Capacitor origin `https://localhost`. The additive backend variable is:

```text
PACKAGED_APP_ORIGINS=https://localhost,tronstudio://app
```

Keep the hosted web origin in `FRONTEND_ORIGIN`; do not replace it with the packaged origins. The public API smoke workflow checks the Android origin before the packaging flow is considered ready.

## Android installer

The `Build Android APK and Windows installer` workflow bundles the local web UI into Capacitor's `dist-mobile` directory, syncs Android, builds `assembleDebug`, and uploads the APK plus SHA-256 checksum. The debug APK is installable for testing but is not a release-signed Play Store package. It does not bundle a wallet recovery phrase or any project/operator secrets.
