# Step 2–3 production audit: backend configuration and sponsor funding

**Audit date:** 2026-10-30  
**Repository:** `MyTeleProject2026/trc20-usdt-token-cloner`  
**Important:** this is a dated operational snapshot. The public smoke workflow must pass again after any live configuration update; provider credentials and balances are never recorded here.

## Step 2 — backend configuration

### Confirmed Render service

- Backend service: `trc20-usdt-token-cloner-api`
- Render service ID: `srv-dbanbem1egvs73bcsdkg`
- Public API: `https://trc20-usdt-token-cloner-api.onrender.com`
- Source branch: `main`
- Health-check path: `/health`
- Runtime start command: `npm start`
- Region/plan at audit time: Oregon / Free
- Latest verified environment-update deployment: `dep-dbhqmb0473hc73am3jdg`, commit `b74be09d4b35a2db88c7b57086fd5de6b6092bbf`, status `live`

The following non-secret values were applied to the backend service using a merge-only environment update: `NODE_ENV=production`, `FRONTEND_ORIGIN=https://trc20-usdt-token-cloner.onrender.com`, and `TATUM_API_BASE=https://api.tatum.io`. Existing environment variables were not replaced. The resulting deployment built successfully, started with `npm start`, logged `Project database initialization: ready`, and listened on Render's assigned port.

The pre-update live API smoke on commit `b74be09d4b35a2db88b9c6a8da4dcc560597de4` passed before the last environment update. A follow-up smoke run, [#40951784898](https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/actions/runs/40951784898), completed successfully after the environment-update deployment. It verified the public health endpoint, the current database/Tatum read-only readiness response, Tatum status `connected`, owner-console configuration with no missing required environment names, live sponsor/testnet preflight response shapes, and that sponsor/treasury submission remains disabled. Future environment changes require a fresh smoke run.

### Remaining Step 2 release blockers

1. **PostgreSQL durability is not production-ready.** Render reports the current database `tronlink_skills_sponsor-ledger` as available on the Free plan with expiry `2026-11-17`. Free Render Postgres instances expire and lack backups. The application has successfully connected, but a current connection is not a durable-storage plan. Upgrade the existing database to a paid plan or migrate to a durable database, verify the migrated data, and only then update the application connection. This requires a billing decision and a controlled migration; this audit did not create a billable resource or modify data.
2. **Auto-deploy is still set to On Commit.** The Render service metadata reports `autoDeploy=yes` / `autoDeployTrigger=commit`. Production should use **After CI Checks Pass** so a commit is not deployed before the required GitHub checks finish. The available Render integration can inspect services and update environment variables, but does not expose the service-settings mutation needed to change this setting. Set this in the backend service's Settings page; see https://render.com/docs/deploys.
3. **A post-environment-update smoke is required.** The prior smoke passed before the latest environment change. The next public smoke result must be checked before recording final Step 2 verification.

Do not add database passwords, provider API credentials, wallet secrets or admin tokens to this file or the frontend.

## Step 3 — real sponsor and treasury funding

### What the live readiness endpoints have established

The public readiness checks and implementation expose read-only configuration and provider diagnostics. They do not make a sponsor funded, authorized, or able to submit transactions.

The latest recorded sponsor integration readiness result showed **12 production submission blockers**, including:

- external sponsor agreement and funded accounts not independently verified;
- provider not verified to supply both asset principal and all transaction costs;
- a production sign/submit/broadcast adapter and managed-signer authorization path not verified/integrated;
- transaction-time sponsor consent and spending mandate verification not integrated;
- atomic fee/resource budget reservation and settlement not integrated end-to-end;
- independent solidified settlement and receiver reconciliation not verified end-to-end;
- authenticated exchange deposit-credit verification not integrated;
- no successful supported testnet end-to-end run recorded;
- no independent security review or Mainnet release approval recorded.

The Nile and Shasta pilot preflight each reported nine blockers. The fee-sponsor address and asset-principal sponsor address were not configured; their on-chain balances and fee/resource capacity had not been verified; delegation, sponsor agreement scope, ownership/mandate review and post-transfer reconciliation were still open.

GasFree API credentials and provider discovery can be present/reachable while funding and transfer submission remain unverified. The currently deployed readiness code explicitly reports that its GasFree sign/submit/broadcast adapter is not integrated, it does not provide the asset principal, and the zero-user-cost policy is not satisfied. Credentials alone do not prove a provider will fund a transaction.

**Production sponsorship and payouts must remain disabled.** Do not set `TREASURY_WITHDRAWALS_ENABLED`, `TREASURY_TRX_WITHDRAWALS_ENABLED`, `SPONSOR_MAINNET_BUDGET_ACTIVATION_ENABLED`, or `SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED` to `true` merely to change a UI status.

### Requirements for a genuine externally funded payout

A legitimate third-party sponsor must explicitly accept and fund the transaction. The sponsor must authorize the exact network, token contract, recipient, maximum amount, costs, fees, and spending mandate using a supported custody/signing flow. The system must verify the real token principal and fee/resource balance, persist an idempotent reservation, require the proper sponsor authorization, broadcast using the authorized provider, and independently verify the solidified transaction and recipient token event before marking it confirmed.

A sender with zero USDT cannot transfer USDT from that sender's wallet. If another organization's treasury supplies the USDT principal and network fees, the resulting transaction normally spends from that sponsor's authorized wallet or contract; it cannot truthfully appear as though the zero-balance user's wallet supplied the tokens. Do not create simulated balances or claim an exchange credited a deposit without the exchange's own confirmation.

A successful read-only balance/provider check is not a substitute for sponsor consent, funding, authorization, a confirmed on-chain transfer, or exchange credit.

## Frontend route inventory

The production source entry point is `src/main.tsx`; the default route renders `WalletVault`, not the staged sponsor workflow. All listed routes are wrapped in `AuthGate`.

| Route | Component | Purpose at source level |
|---|---|---|
| `#/` and `#/wallet` | `WalletVault` | Wallet vault, assets, owner treasury checks, send, activity and settings |
| `#/watch-wallets` | `WatchOnlyWallets` | Read-only monitoring of public TRON addresses |
| `#/exchange-deposit` | `MainnetExchangeDeposit` | Mainnet wallet-to-exchange transfer flow; sender wallet and real assets/fees are required |
| `#/okx-deposit-status` | `OkxDepositStatus` | Read-only exchange deposit-status lookup |
| `#/workspace` | `WorkflowApp` | Staged testnet sponsor/asset/recipient review workflow |
| `#/sponsor-operator` | `SponsorSignerConsole` | Testnet sponsor-role diagnostics and explicit wallet-signed resource delegation |

The UI already separates read-only diagnostics, testnet sponsor operations, direct Mainnet wallet transfers, and exchange deposit status. Keep these states distinct. The current sponsor readiness view is preflight only; it must not be presented as a working Mainnet sponsored-transfer feature.

## Required exit criteria

- [ ] Upgrade/migrate PostgreSQL to a durable plan, verify data and confirm the active backend connection uses the intended database.
- [ ] Set the backend service to **After CI Checks Pass** in Render and verify the setting.
- [ ] Confirm a successful public API smoke run after the latest environment update.
- [ ] Receive and independently verify a real sponsor agreement/mandate and funded sponsor account(s) for the exact network, USDT contract, principal and fees.
- [ ] Complete a controlled authorized testnet sponsor transfer and independently verify the solidified receipt, exact recipient/amount/token event, and settled sponsor cost.
- [ ] Complete independent security/operator review before considering any Mainnet submission.
- [ ] Verify exchange deposit credit from the receiving exchange's own authorized record when that is part of the use case.

**Current verdict:** backend runtime configuration is deployed and basic startup/database connectivity has been observed. Step 2 is not fully production-complete until database durability, CI-gated deployment and post-update verification are closed. Step 3 remains blocked because no fully authorized, funded and end-to-end verified sponsored payout path has been established.
