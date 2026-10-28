# Single-owner Wallet Control Panel

The bundled web application and Android APK now enter through `src/OwnerControlApp.tsx`. Legacy sponsor, exchange-status, and watch-only pages are no longer exposed as client-side routes. The active workspace is the local Wallet Vault.

## Authentication model

- The API provisions exactly one owner account, stored in PostgreSQL under `trc20_token_clone.owner_auth_accounts`.
- First-time setup requires `OWNER_SETUP_KEY`, configured only as a secret environment variable on the backend. Setup is atomic; later setup requests are rejected.
- Owner passwords are stored as scrypt hashes. Plain passwords and the setup key are not persisted.
- Session tokens are random and time-limited (8 hours); PostgreSQL stores only their SHA-256 digests, bound to the allowed application origin.
- Login does not need TronLink. The app owner password authenticates the application; the separate Wallet Vault password encrypts/decrypts local wallet keys. The backend does not receive private keys or recovery phrases.
- If the API database is missing or unavailable, account setup and sign-in fail closed.

## Render API environment variables

Configure these on the **backend API** service, not in the frontend or source repository:

1. `DATABASE_URL`: the managed PostgreSQL connection string used by the API. It must point to a persistent database. Do not paste it into public issues or commit it.
2. `OWNER_SETUP_KEY`: a high-entropy one-time initialization secret with at least 32 characters. Generate a fresh value locally (for example, `openssl rand -base64 48`) and paste it into the Render environment dashboard. Never place this value in GitHub or frontend environment variables.
3. `FRONTEND_ORIGIN`: the exact HTTPS origin of the hosted frontend, such as `https://trc20-usdt-token-cloner.onrender.com`.
4. `PACKAGED_APP_ORIGINS`: include the origins used by packaged clients, comma-separated. For the current Capacitor Android origin, include `https://localhost`. You may also include `tronstudio://app` if that desktop scheme is used. Preserve any existing required entries instead of replacing them.

After setting the values, redeploy the API and open the application. Choose **Initialize the owner account**, submit the configured setup key, owner email, and a strong password, then return to **Sign in**. The setup key is required only for the first account creation. If an account already exists, the API will not create a second account; there is no public registration.

If the Android APK is packaged against the hosted API, ensure its `VITE_API_BASE_URL` points to the deployed API origin at build time. Never embed `OWNER_SETUP_KEY`, wallet private keys, or treasury signing credentials in the APK.

## Wallet and asset boundaries

The owner console can create or import a software wallet, read public chain balances, verify token contracts, and sign user-reviewed transactions locally. A wallet's owner login does not imply that the wallet holds assets. Real USDT transfers require actual USDT at the sender or a legitimately funded, authorized treasury. Sponsored transaction fees cover network fees only; they do not create USDT. A transaction is shown as confirmed only when the corresponding on-chain receipt supports that status. Exchange credit is a separate decision made by the receiving platform.

Before using Mainnet funds, independently audit local key storage, recovery, Android device security, transaction review, and any treasury custody controls.
