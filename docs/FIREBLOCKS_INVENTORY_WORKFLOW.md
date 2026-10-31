# Fireblocks read-only inventory workflow

The GitHub Actions workflow `.github/workflows/fireblocks-inventory-sync.yml` is a manually dispatched, read-only inventory check. It authenticates to the existing Fireblocks workspace through the backend, verifies the configured vault and TRON assets, checks the corresponding public TRON address and balances, stores a sanitized audit snapshot in PostgreSQL, and uploads a short-lived configuration ZIP.

## One-time backend and GitHub setup

The workflow cannot create a Fireblocks organization, accept a Fireblocks invitation, approve a workspace, create an API user, or generate the API user's RSA key. Those are organization-admin operations in Fireblocks. Complete those once, then use the workflow for repeatable verification.

On the Render backend, keep the following values server-side:

- `FIREBLOCKS_API_KEY`: API key for a dedicated least-privilege Fireblocks API user.
- `FIREBLOCKS_SECRET_KEY_PATH`: mounted RSA-4096 API-user key file path.
- `FIREBLOCKS_API_BASE`: the correct Fireblocks region endpoint.
- `FIREBLOCKS_VAULT_ACCOUNT_ID`, `FIREBLOCKS_USDT_ASSET_ID`, `FIREBLOCKS_TRX_ASSET_ID`: exact identifiers from the authorized workspace.
- `TREASURY_ADDRESS`: the public TRON address assigned to the two assets.
- `DATABASE_URL`: existing PostgreSQL connection string.

Create a GitHub Actions Environment named `fireblocks-readonly-sync`. Configure required reviewer approval on this Environment when repository settings permit it. No long-lived workflow trigger secret is needed: the job requests a short-lived GitHub Actions OIDC token and the backend validates its signature, issuer, custom audience, repository and owner IDs, `main` ref, exact workflow file, `workflow_dispatch` event, Environment name, run ID, attempt, and commit SHA. The backend does not need an additional OIDC secret or new environment variable. Do not put the Fireblocks API key or RSA key in GitHub Actions secrets; the runner never receives Fireblocks credentials.

The API user should have only the read permissions needed for vault account, asset metadata, balances, and asset-address reads. It does not need transaction creation, signing, or approval permissions.

## Running it

Open **GitHub → Actions → Fireblocks read-only inventory sync and config export → Run workflow**, select `main`, choose `RUN_READ_ONLY_SYNC`, and dispatch the workflow.

The backend checks:

1. Fireblocks API authentication and the configured vault account.
2. Whether the USDT and TRX assets are active in that vault.
3. Whether the USDT asset metadata maps to the official TRON Tether contract `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`.
4. Whether the TRX asset is native TRX with six decimals and no token contract.
5. Whether the USDT and TRX asset addresses each resolve to the configured treasury address.
6. Public TRON USDT symbol/decimals/balance and native TRX balance.
7. Persistence of the sanitized run record in `trc20_token_clone.fireblocks_inventory_snapshots`.

The workflow uploads the `fireblocks-inventory-config` artifact, containing `fireblocks-verified-config.json`, `fireblocks.nonsecret.env`, and a README. It is available in the workflow run's Artifacts section for 14 days. A blocked verification still generates a diagnostic bundle, but the workflow ends with a failed status so that a blocked run is not confused with a verified one.

## Secret handling and limitations

The artifact intentionally excludes `FIREBLOCKS_API_KEY`, the RSA private key, database credentials, GitHub OIDC tokens, Fireblocks JWTs, and wallet private keys. Those values must remain in Render's secret store. A portable EXE containing those credentials would be extractable and unsafe; a sanitized ZIP plus non-secret environment file is the correct export format. The `.env` file is not a replacement for the backend's secret-file mount or database connection.

This is inventory verification only. It does not create or approve vaults, change Fireblocks policies, fund assets, enable payouts, sign transactions, or submit transfers. The existing hard-coded real-value payout execution lock remains unchanged, and both payout feature flags are exported as `false`.
