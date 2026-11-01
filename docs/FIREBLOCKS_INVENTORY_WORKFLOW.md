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

## Owner-console status display

After the manual workflow completes, the private owner console reads the latest saved snapshot from `GET /api/treasury/fireblocks/inventory/latest`. This endpoint requires the existing Mainnet owner session, matching request origin, and the same `OWNER_WALLET_ADDRESS` / `TREASURY_OWNER_ADDRESS` identity. It returns only allow-listed public configuration identifiers, sanitized check results, balances, timestamps, and workflow run metadata. The secret-file path and all credentials are excluded.

Open **Wallet Vault → Fireblocks treasury setup → One-click Fireblocks inventory verification** to see the latest saved run. The panel links to the matching GitHub Actions run and distinguishes a passed inventory check from a blocked run. It displays the provider and chain observations side by side so mismatches are visible.

A missing snapshot means no run has been successfully persisted yet. A blocked snapshot contains diagnostic reason codes; fix the actual provider/database configuration and dispatch a new run. Do not edit the database row or treat an artifact with a blocked status as verified.

This endpoint and panel are read-only. Even a `verified` inventory snapshot does not authorize a payout, prove organizational approval, enable signing, or confirm an exchange deposit. The backend hard lock and both payout feature flags remain disabled.

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

## Network and runtime timeouts

The inventory path is bounded so a slow provider cannot occupy the manual GitHub runner indefinitely:

- Each Fireblocks HTTP request has a 15-second timeout. All Fireblocks reads in one inventory operation also share a 90-second cancellation deadline, including paginated address reads.
- TRONGrid full-node and solidity-node HTTP requests use an explicit 12-second timeout.
- The GitHub runner allows 10 seconds to establish the backend connection and 150 seconds for the complete backend request. The workflow job still has its own 10-minute outer limit.

A timeout is a failed/blocked inventory attempt, not a positive verification. Dispatch a new run after the underlying provider or network issue is resolved; do not disable the timeouts to force a green result.

## Secret handling and limitations

The artifact intentionally excludes `FIREBLOCKS_API_KEY`, the RSA private key, database credentials, GitHub OIDC tokens, Fireblocks JWTs, and wallet private keys. Those values must remain in Render's secret store. A portable EXE containing those credentials would be extractable and unsafe; a sanitized ZIP plus non-secret environment file is the correct export format. The `.env` file is not a replacement for the backend's secret-file mount or database connection.

This is inventory verification only. It does not create or approve vaults, change Fireblocks policies, fund assets, enable payouts, sign transactions, or submit transfers. The existing hard-coded real-value payout execution lock remains unchanged, and both payout feature flags are exported as `false`.
