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

This build does not generate a BIP-39 mnemonic/recovery phrase. The recovery path provided by this iteration is the app-specific encrypted JSON backup plus its password. Real TRX and TRC-20 transfer controls are available after an explicit review, local signing and signed-transaction broadcast. The wallet has not undergone an independent security audit. Transfers must be treated as irreversible. History stored on this device is an activity aid, not a ledger guarantee. On reload, each entry is marked local/unverified until a selected TRON node returns a raw transaction matching the sender, recipient, operation, amount and token contract. A locally saved status is never treated as proof.

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


## Owner-only treasury funding preflight (read-only)

The Wallet Vault now has a Mainnet-only owner treasury check. The owner unlocks the local wallet and signs a short identity challenge; the backend compares the authenticated Mainnet address against `TREASURY_OWNER_ADDRESS`. The owner address and treasury funding address are separate configuration values:

- `TREASURY_OWNER_ADDRESS`: public Base58Check address allowed to view treasury status; the owner must unlock this address in the local Wallet Vault and sign the identity challenge.
- `TREASURY_MAINNET_ADDRESS`: preferred watch-only address whose actual Mainnet TRX and official Tether TRC-20 USDT balances are read. No private key is needed to monitor this address.
- `SPONSOR_MAINNET_ADDRESS`: backward-compatible fallback monitor address if `TREASURY_MAINNET_ADDRESS` is blank. If both monitor variables are blank, the owner address is monitored.
- `TATUM_API_KEY`: server-side provider credential for solidified/read-only balance queries.
- `DATABASE_URL`: persistent session storage required by wallet authentication.
- `FRONTEND_ORIGIN`: existing hosted frontend origin allowlist.
- `PACKAGED_APP_ORIGINS=https://localhost,tronstudio://app`: add packaged app origins without replacing `FRONTEND_ORIGIN`.

Never put private keys, provider secrets, signer secrets, or admin tokens in any `VITE_*` variable or in the APK. The new `GET /api/treasury/owner/funding-status?network=mainnet` endpoint is owner-session protected and read-only. It deliberately returns `canSubmitSponsoredTransfer=false` and `submissionEnabled=false`. A watch-only address can only be read: it cannot sign or authorize an outgoing transfer. Monitoring a separate treasury also does not allow the local owner wallet to spend the treasury's assets.

The backend includes an **optional owner-only, treasury-backed Mainnet withdrawal route** documented in [OWNER_TREASURY_PAYOUTS.md](OWNER_TREASURY_PAYOUTS.md). It can send only genuine USDT already held by the configured server treasury; the owner identity wallet does not have to hold the USDT principal. The treasury must still hold genuine USDT and enough real TRX to cover the configured maximum fee cap. Readiness and each payout request now check that native fee budget; the route does not claim gas sponsorship unless a separately verified sponsor adapter is implemented. This opt-in hot-wallet signing path is not independently audited; keep it disabled until the environment, limits, key custody, and recovery process have been reviewed.

The withdrawal route includes owner-session authorization, a persistent idempotency ledger, daily and per-payout caps, conservative reservations for unresolved broadcasts, and chain verification of the exact sender, official token contract, recipient, amount, successful solidified receipt, and matching official USDT Transfer event. A broadcast-accepted status is not confirmation, and on-chain confirmation does not guarantee that an exchange credits a deposit. Never represent an internal/generated balance as an external deposit.

## Watch-only address monitor

Open `#/watch-wallets` from the Wallet Vault to add public TRON addresses for monitoring. The list is stored in this browser/app's local storage and the page reads TRX balances from the selected public TRON network. On Mainnet it also reads the balance of Tether's official TRC-20 USDT contract (`TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`). Testnet balances are kept separate.

A watch-only address does not grant control over the wallet. A public address cannot be reversed into a private key; this screen does not recover, reveal, copy, or transmit private keys and does not sign or broadcast transactions. To spend from an address, the authorized owner must use the original key/seed or an appropriate secure signer. No balance is created by monitoring an address. Treasury payouts, if introduced later, require a separately authorized signer, genuine treasury assets, access controls, payout limits, replay protection, and verified transaction receipts.



## Single-owner application login

The application UI is gated by a single-owner login. There is no public registration or self-service account creation. Configure these variables on the **backend service only**:

- `OWNER_WALLET_ADDRESS`: the one permitted TRON address in Base58 format.
- `OWNER_PASSWORD_HASH`: a scrypt password hash. Never store the plaintext password in Render variables or Git.
- `DATABASE_URL`: required for server-side session persistence and logout revocation.
- `FRONTEND_ORIGIN`: the exact deployed frontend origin; packaged clients must be explicitly allowlisted in `PACKAGED_APP_ORIGINS` (for the current Capacitor APK, include `https://localhost`; include `tronstudio://app` only if the desktop shell is deployed).

Generate a password hash locally with Node.js 22+ (replace the example password locally; do not send it to anyone):

```sh
node --input-type=module -e "import { randomBytes, scrypt } from 'node:crypto'; import { promisify } from 'node:util'; const derive = promisify(scrypt); const password = process.argv[1]; if (!password || password.length < 16) throw new Error('Use a unique password with at least 16 characters'); const salt = randomBytes(16); const key = await derive(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 67108864 }); console.log('scrypt$' + salt.toString('base64url') + '$' + Buffer.from(key).toString('base64url'))" 'REPLACE_WITH_A_LONG_UNIQUE_PASSWORD'
```

Copy only the printed `scrypt$...` output into Render's `OWNER_PASSWORD_HASH` value. Set `OWNER_WALLET_ADDRESS` to the exact owner address. Restart/redeploy the backend after setting the variables. Do not put any private key or seed phrase into these variables.

Owner login issues a 15-minute session stored server-side by token hash. The browser keeps the bearer token in session storage, clears the password after login, and exposes a sign-out action. Failed attempts are rate-limited per backend process; use a strong unique password and protect the Render account with MFA. The login session proves access to the owner console only; it does not create USDT, fund withdrawals, or authorize transfers without actual assets and network fees.

**Deployment note:** setting these variables is an operator action; repository changes cannot set secret Render environment variables on your behalf. The app will fail closed with an explicit configuration message until the owner address, password hash, database and origin allowlist are configured.
