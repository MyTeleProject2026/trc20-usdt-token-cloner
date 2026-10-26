# Sponsor operator manual opt-in runbook (testnet first)

This is a hands-on operator checklist for `MyTeleProject2026/trc20-usdt-token-cloner`.
It is not a declaration that sponsorship is production-ready. Follow it in order. Do not skip
readiness checks because an environment variable or wallet connection appears successful.

## 0. Current safe mode

Use **Nile testnet only** for initial setup. Shasta can be used as a separate test environment,
but do not mix addresses, token contracts, transactions, or balances between the two networks.

Keep these backend environment values set exactly as follows throughout initial onboarding:

```text
SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED=false
SPONSOR_MAINNET_BUDGET_ACTIVATION_ENABLED=false
SPONSOR_TESTNET_MAX_FEE_LIMIT_SUN=50000000
```

The first flag is the opt-in for an experimental Shasta/Nile signer-and-broadcast route. Do not set
it to `true` during the setup steps below. Budget activation is an internal ledger control; it does
not authorize a specific transfer. Mainnet transaction submission is not available through this
experimental testnet route.

## 1. Get the actual sponsor authorization outside the application

Before adding any agreement reference or marking a budget active, obtain explicit written approval
from the owner of **each** sponsor wallet. The approval should identify:

- the legal person/organization authorizing the use and how the wallet owner was verified;
- the fee/resource sponsor wallet and the separate asset-principal sponsor wallet;
- the permitted network (Nile), asset and exact token contract, maximum aggregate budget, per-transfer
  cap, recipient policy, expiry, and who can pause/stop sponsorship;
- what fees the sponsor agrees to cover, what is excluded, and confirmation that no user-funded
  fallback is permitted;
- the agreement/reference ID and an operator review/ticket ID.

Do not infer consent from a wallet balance, an address typed into Render, a successful wallet
connection, or a provider API key. Do not use Mainnet funds for this pilot. Never share a seed phrase,
private key, recovery phrase, wallet password, or the admin token in ChatGPT, GitHub, screenshots,
browser forms, or issue comments.

## 2. Configure only the backend Render Web Service

Open the backend service, not the frontend Static Site:

- Service: `trc20-usdt-token-cloner-api`
- Dashboard: https://dashboard.render.com/web/srv-dbanbem1egvs73bcsdkg
- Select **Environment**. Add/update individual variables; do not choose a replace-all operation.

Keep existing working values for `DATABASE_URL`, `TATUM_API_KEY`, and `FRONTEND_ORIGIN`.
Do not paste them into messages or overwrite them without a reason.

Set the following testnet values only after the sponsor owners authorized monitoring:

| Variable | Value |
| --- | --- |
| `SPONSOR_FEE_NILE_ADDRESS` | Public Nile address owned by the network-fee/resource sponsor |
| `SPONSOR_ASSET_NILE_ADDRESS` | Public Nile address owned by the asset-principal sponsor; must differ from the fee sponsor |
| `SPONSOR_USDT_NILE_CONTRACTS` | Comma-separated exact Nile token contract addresses reviewed for this pilot; omit if no approved token is used |
| `SPONSOR_VTRC_NILE_CONTRACTS` | Exact Nile VTRC contract address(es) only, if VTRC is in scope; VTRC is not official USDT |
| `SPONSOR_ADMIN_API_TOKEN` | A newly generated random secret with at least 32 characters, kept only in Render and an authorized local admin secret manager |
| `SPONSOR_APPROVED_AGREEMENT_REFERENCES` | The exact reviewed agreement scopes described in section 3 |
| `SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED` | Keep `false` |
| `SPONSOR_MAINNET_BUDGET_ACTIVATION_ENABLED` | Keep `false` |

The budget-drafting endpoint for role-specific testnet budgets also needs a database. If a configured
token contract is malformed, belongs to the wrong network, or is not in the allowlist, stop and fix
the configuration; do not substitute another contract by symbol alone.

After saving, let Render restart/deploy the service. Confirm that the latest deploy reports **Live**
before doing read-only checks. Do not send secrets to the frontend; do not create `VITE_*` versions
of any server secret.

## 3. Add exact agreement scopes (server-side only)

`SPONSOR_APPROVED_AGREEMENT_REFERENCES` is a semicolon-separated list. Every entry uses exactly:

```text
reference|sponsorReference|network|sponsorAddress|purpose|asset|tokenContract
```

Examples of the required *shape* (replace every example value with the values in the signed approval;
these examples are not approvals and must not be deployed literally):

```text
<fee-agreement-ref>|<fee-sponsor-ref>|nile|<fee-sponsor-address>|network-fee|TRX|-
<asset-agreement-ref>|<asset-sponsor-ref>|nile|<asset-sponsor-address>|asset-grant|TRX|-
<token-agreement-ref>|<asset-sponsor-ref>|nile|<asset-sponsor-address>|asset-grant|USDT|<exact-nile-token-contract>
```

Join the actual entries with semicolons, without line breaks inside an entry. Use `-` for
`tokenContract` with native TRX. For a token budget, the reference must match the exact token contract.
The reference must trace back to a real signed/approved scope; a syntactically valid string is not proof
of sponsor consent. Only include the assets and scopes actually approved.

## 4. Confirm read-only chain and deployment status first

After the backend is live, open these URLs in a browser. They are diagnostics only:

1. Health: https://trc20-usdt-token-cloner-api.onrender.com/health
2. General readiness: https://trc20-usdt-token-cloner-api.onrender.com/api/readiness
3. Sponsorship capability (must remain disabled): https://trc20-usdt-token-cloner-api.onrender.com/api/tron/sponsorship/status
4. Integration preflight: https://trc20-usdt-token-cloner-api.onrender.com/api/tron/sponsorship/integration-readiness
5. Both testnet pilot preflights: https://trc20-usdt-token-cloner-api.onrender.com/api/tron/sponsorship/testnet-pilot-readiness?network=both&refresh=1
6. Nile sponsor roles: https://trc20-usdt-token-cloner-api.onrender.com/api/tron/sponsorship/roles?network=nile&refresh=1

Stop if a route returns an error, either wallet is missing, the roles are not distinct, token balances
cannot be verified, or the pilot response contains blockers. A response saying
`live-chain-preflight-passed-review-required` is still **not** transaction authorization; ownership,
spending mandate, and fee settlement still require review.

The operator console is at https://trc20-usdt-token-cloner.onrender.com/#/sponsor-operator. Connect
TronLink using the wallet that owns the **Nile fee sponsor** address, and confirm that TronLink's node
is Nile before requesting any signature. The console must reject the wrong network. Only sign a
resource-delegation transaction when the screen's sponsor address, principal recipient address,
resource type, stake-equivalent amount, and expiry are all exactly what the approved plan specifies.
Resource delegation is not an asset transfer and does not prove that a later transaction has zero fees.

## 5. Create role-specific budget drafts — no transfer is sent

These protected API operations need an authenticated request using the `SPONSOR_ADMIN_API_TOKEN`.
Use a trusted local terminal or private API client. Never put the token in a public request tester,
public paste site, browser query string, frontend JavaScript, or chat.

The testnet-only draft endpoint is:

`POST https://trc20-usdt-token-cloner-api.onrender.com/api/tron/sponsorship/role-budget-drafts`

Headers:

```text
Authorization: Bearer <SPONSOR_ADMIN_API_TOKEN>
Content-Type: application/json
```

Fee/resource budget draft body (integer base-unit string; this is a cap, not funding):

```json
{
  "network": "nile",
  "role": "network-fee-sponsor",
  "sponsorReference": "<fee-sponsor-reference>",
  "asset": "TRX",
  "budgetBaseUnits": "<approved-TRX-cap-in-sun>"
}
```

Asset-principal draft body for native TRX:

```json
{
  "network": "nile",
  "role": "asset-principal-sponsor",
  "sponsorReference": "<asset-sponsor-reference>",
  "asset": "TRX",
  "budgetBaseUnits": "<approved-TRX-principal-cap-in-sun>"
}
```

For an allowlisted token, use `"asset": "USDT"` or `"asset": "VTRC"`, add
`"tokenContract": "<exact-nile-contract-address>"`, and use the approved integer base-unit cap for
that contract's decimals. Do not guess token decimals. Both requests must return a
`pending-review` draft; a draft does not reserve funds, activate a budget, sign, or send a transfer.
Record each returned budget ID privately for the operator review.

## 6. Activate a budget only after independent review

Activation uses:

`POST https://trc20-usdt-token-cloner-api.onrender.com/api/tron/sponsorship/budgets/<budget-id>/activate`

Headers are the same as in section 5. Request body:

```json
{
  "consentReference": "<exact-allowlisted-agreement-reference>",
  "reviewReference": "<operator-review-ticket-reference>"
}
```

Before calling it, independently compare the draft's network, sponsor role/address, asset, contract,
cap and sponsor agreement with the written approval. The backend rechecks the approved scope and a
fresh solidified funding snapshot, and rejects a role/address mismatch or insufficient on-chain
balance. Successful activation only makes that ledger cap eligible for internal reservations; the
response should still say `canSubmitSponsoredTransfer: false` and `submissionEnabled: false`.
Stop if it does not.

Do not activate Mainnet budgets during this pilot. Do not create a draft for an amount bigger than
the sponsor-approved cap or the funding evidence supports. If a draft already exists, do not invent a
second sponsor reference to bypass the duplicate protection.

## 7. What is still needed before even a controlled testnet transfer

The current repository still requires a supported end-to-end pilot and settlement evidence before
the signed-broadcast flag should be considered. This includes: a real sponsor-authorized and
funded testnet transaction, persisted intent and replay/idempotency checks, a successful solidified
receipt matching the exact sender/receiver/token/amount, a receiver balance query on the same network
and contract, separately reconciled fee/resource expense, failure/timeout handling, and an operator
review of the audit trail.

Until those checks are completed, leave `SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED=false`.
If any state is ambiguous, pause and reconcile the same stored intent; never retry with a different
transaction just to make the UI appear successful. The application must not deduct the transfer
principal from the receiver's amount and must never fall back to charging the sender.

## 8. Mainnet release is a separate future decision

Do not set either Mainnet-related flag to `true` as part of this checklist. Mainnet readiness needs a
separately reviewed provider/signer adapter, sponsor mandate and funding, security review, spend
limits, independently verified final fee settlement, tested incident response, and explicit operator
release approval. The current testnet flag does not enable Mainnet broadcasting.

A confirmed TRON transfer is not the same as a credited exchange deposit. Only the receiving wallet or
exchange's actual on-chain/network policy and its own confirmation system can report that deposit as
credited. Never display simulated or unusable balances as external wallet/exchange funds.

## 9. Wallet-address login and dashboard use

The main workflow now defaults to the **Nile testnet**. Open
https://trc20-usdt-token-cloner.onrender.com and choose **Connect & sign in with TronLink**.

1. In TronLink, explicitly select Nile and connect the public address you intend to use.
2. The app requests a one-time, human-readable sign-in challenge from `POST /api/auth/tron/challenge`.
3. Review the message in TronLink and sign it only if it clearly says it proves address control and authorizes no transfer. This is a message signature, not a blockchain transaction.
4. The backend recovers the signing address using TronWeb and checks the address, network, allowed frontend origin, challenge expiry, and one-time nonce. The dashboard displays “Wallet login verified” only when the recovered address matches.
5. After successful login, the app refreshes the selected testnet wallet snapshot and both sponsor-role snapshots. The sponsor cards display actual chain reads where available, not pretend balances.

A public TRON address by itself is not authentication. Watch-only mode can inspect public balances but cannot log in as the address owner. A signed login proves control of that address only; it does not prove that the connected address is either sponsor, that the sponsor consented, or that the sponsor may spend. The returned session is memory-only and expires; a backend restart invalidates it. It is not yet a persistent production identity store, and no transfer API is authorized by this session.

## 10. Render PostgreSQL readiness after restart

The backend log previously reported `DEPTH_ZERO_SELF_SIGNED_CERT` and database persistence unavailable. The connection code now recognizes Render's private internal Postgres hostname and strips external-URL SSL query options from that internal URL. Render documents that internal same-region connections use private networking and TLS is optional; external database URLs still require TLS.

After the latest backend deploy reports **Live**, inspect:

- https://trc20-usdt-token-cloner-api.onrender.com/health
- https://trc20-usdt-token-cloner-api.onrender.com/api/readiness
- https://trc20-usdt-token-cloner-api.onrender.com/api/storage/status

The Render startup log should say `Project database initialization: ready`. Do not switch to a plaintext external database connection. If the connection continues to fail, open the Render Postgres service's **Connect** panel and confirm `DATABASE_URL` is the **Internal Database URL** for this same-region Render service. Never paste the URL into chat or GitHub. If you deliberately use an external URL, retain its TLS requirement and do not apply the internal-host workaround to it.



## 11. Tatum gateway rate-limit recovery

The backend now paces requests to approved Tatum REST and TRON gateway origins through a shared per-process queue, spacing request launches by 400 ms to reduce bursts from concurrent balance/resource checks. This is rate-limit hygiene, not an increase to the Tatum account quota. Tatum documents HTTP 429 as a request-rate limit response ([official error guide](https://docs.tatum.io/docs/error-429)).

If Nile continues returning HTTP 429, inspect the Tatum dashboard for the API-key type, plan limits, and recent request usage, and wait for the relevant limit window to clear before retrying. Do not repeatedly force refreshes during a throttle window. A 429 remains a testnet preflight blocker; do not enable signing/broadcast or switch to a sender-funded fallback to work around it.
