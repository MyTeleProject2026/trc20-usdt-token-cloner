# Sponsor operator manual opt-in runbook (testnet first)

This is a hands-on operator checklist for `MyTeleProject2026/trc20-usdt-token-cloner`.
It is not a declaration that sponsorship is production-ready. Follow it in order. Do not skip
readiness checks because an environment variable or wallet connection appears successful.

## Historical Render testnet flag record (2026-10-27; live state unverified)

An earlier operator note recorded that `SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED` had been set to `true` and that a Render deployment became live. This is a historical configuration record only. The current Render value has not been independently inspected, and a live deployment or configured flag is not evidence of an actual sponsored transfer.

The current source code contains a hard release gate in `server/routes/sponsor-fee-settlement-gate.mjs`. It returns not-ready until the independent release evidence and acceptance requirements are completed. Setting `SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED=true` cannot bypass that source-code gate. Keep the flag `false`; do not dispatch signing or transfer tests as a workaround. Mainnet submission remains unavailable.

## 0. Safe baseline for initial onboarding

Use **Nile testnet only** for initial setup. Shasta can be used as a separate test environment,
but do not mix addresses, token contracts, transactions, or balances between the two networks.

For a new deployment before a controlled test, use this safe baseline:

    SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED=false
    SPONSOR_MAINNET_BUDGET_ACTIVATION_ENABLED=false
    SPONSOR_TESTNET_MAX_FEE_LIMIT_SUN=50000000

The current live Render value is unverified. Keep this flag `false`. The source-code release gate also blocks signing and broadcast, even if the environment flag is accidentally true. The separate resource-ledger approval and historical evidence requirements must not be bypassed. Mainnet transaction submission is not available through this experimental route.

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
Do not paste them into messages or overwrite them without a reason. `TRONGRID_API_KEY` is an optional
backend-only key for read-only TRON resource diagnostics. When both provider keys are configured,
the reader prefers TRONGrid and retries an individual failed resource query through Tatum; it does not
switch providers for transaction submission because this reader has no submission capability.

Set the following testnet values only after the sponsor owners authorized monitoring:

| Variable | Value |
| --- | --- |
| `TRONGRID_API_KEY` | Optional server-only TRONGrid API key for resource preflight; never create a `VITE_*` frontend copy |
| `SPONSOR_FEE_NILE_ADDRESS` | Public Nile address owned by the network-fee/resource sponsor |
| `SPONSOR_ASSET_NILE_ADDRESS` | Public Nile address owned by the asset-principal sponsor; must differ from the fee sponsor |
| `SPONSOR_USDT_NILE_CONTRACTS` | Comma-separated exact Nile token contract addresses reviewed for this pilot; omit if no approved token is used |
| `SPONSOR_VTRC_NILE_CONTRACTS` | Exact Nile VTRC contract address(es) only, if VTRC is in scope; VTRC is not official USDT |
| `SPONSOR_ADMIN_API_TOKEN` | A newly generated random secret with at least 32 characters, kept only in Render and an authorized local admin secret manager |
| `SPONSOR_APPROVED_AGREEMENT_REFERENCES` | The exact reviewed agreement scopes described in section 3 |
| `SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED` | Keep `false`. This flag cannot bypass the hard source-code release gate; do not enable before independent pilot approval. |
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

## 3A. Use the sponsor operator console for an existing approved reservation

Open the frontend route:

- https://trc20-usdt-token-cloner.onrender.com/#/sponsor-operator

Use an already-created, approved reservation. The signing console accepts the reservation idempotency key; it does not create or approve a reservation.

1. Select the exact reservation network (Nile or Shasta). Do not switch networks mid-flow. Refresh the dual-testnet preflight and sponsor-role diagnostics. Stop if the fee and asset-principal sponsor roles are missing, the addresses are not distinct, the configured token contract is not the exact allowlisted contract, or required resource/funding checks report blockers.
2. If the required fee-resource delegation has not yet been verified, the fee/resource sponsor owner must connect the wallet that owns the configured fee sponsor address, review the intended recipient/resource/amount, sign the delegation in TronLink, and use the console read-only verification action. Continue only after the resulting delegation is verified from solidified chain state. This delegation is separate from sending token principal.
3. The asset-principal sponsor owner then connects the wallet that owns the reservation sponsor address on the same testnet. In the Load approved reservation section, enter the approved reservation idempotency key (24–160 characters) locally in the console. Do not post admin tokens, API keys, private keys, seed phrases or recovery phrases in chat or GitHub.
4. Click Prepare exact transaction for review. Inspect the displayed network, sponsor address, receiver address, asset, exact base-unit amount, token contract, and fee-capacity status. This first click must not open a wallet signature prompt or broadcast anything. When the details match the approved reservation, click Sign exact reviewed transaction in TronLink. Before approving the wallet prompt, compare the details again and reject it if any field differs. The console verifies that the connected wallet is the approved asset-principal sponsor and that signed raw bytes and transaction ID exactly match the persisted intent before asking the backend to run its final checks and testnet broadcast.
5. If the node accepts the transaction, the console shows its returned transaction ID and starts a separate solidified-receipt and receiver-balance check. Open the transaction explorer link for that exact ID. If the console says it was already broadcast, use the receipt/recheck control instead of signing again. An ambiguous or pending result is not permission to create a new transaction: recheck the same stored reservation/transaction ID. Never invent a hash or label a transaction as received before the chain evidence supports that state.
6. Treat the transfer as complete only after the solidified transaction body and receipt are verified, contract execution succeeded, the expected native transfer or exact TRC-20 Transfer event matches the saved sender/receiver/token/amount, the receiver chain balance is re-read, and sponsor expense/fee reconciliation is complete. An exchange deposit is a separate state controlled by the exchange; a public-chain transfer alone does not prove an exchange account credited it.

The feature flag being enabled only opens the testnet route gate. It does not prove that an approved reservation exists or that any transaction was signed, broadcast, solidified, or credited.

## 3B. Reservation idempotency key: what it is and where to get it

An idempotency key is a unique caller-chosen/generated label for one exact reservation request. The database stores it under a unique constraint together with the exact intent (network, sponsor reference, purpose, asset, token contract, receiver and base-unit amount). Repeating the same request with the same key returns the existing reservation instead of reserving the budget twice. Reusing that key with different transfer details returns an idempotency conflict. The key is not a transaction hash, wallet signature, password, approval, or proof that funds moved.

**If creating a new approved reservation:** run the repository helper from a trusted local checkout after setting `SPONSOR_ADMIN_API_TOKEN` in your local shell (not in the browser or chat). For example, supply the real approved Nile sponsor reference, receiver, asset, exact contract where applicable, and exact base-unit amount:

```bash
npm run sponsor:reserve -- \
  --network nile \
  --sponsor-reference <approved-sponsor-reference> \
  --purpose asset-grant \
  --asset TRX \
  --receiver <receiver-nile-address> \
  --amount-base-units <approved-amount-in-sun>
```

For USDT/VTRC, use the exact allowlisted contract and the correct base-unit amount for that contract's decimals. Do not copy the TRX example amount into a token request. If `--idempotency-key` is omitted, the helper generates one, prints **Reservation idempotency key:** in its output, and stores a private local recovery record under `~/.trc20-token-studio/reservations/` (unless `SPONSOR_RESERVATION_STATE_DIR` is set). Keep the key and recovery record in the approved operator's secure local workspace. A successful command creates an internal reservation only; it does not sign or broadcast.

**If you already have an approved reservation:** do not create another reservation just to obtain a key. Recover the exact key from the original helper output or matching local recovery JSON. Then enter that key in the sponsor operator console's **Load approved reservation** field. The console requires the reservation's idempotency key, not the explorer transaction hash, sponsor budget ID, or receiver address.

**If the key is lost:** inspect the original operator's recovery file or have the database operator locate the existing reservation record using the approved internal procedure. Do not guess a key or make a replacement reservation until the existing row and status are resolved. If a request timed out, retry the exact same request with the same key; never use a new key to retry an uncertain outcome. The helper writes its recovery state locally and prints the key again when invoked with `--idempotency-key <same-key>`.

## 4. Confirm read-only chain and deployment status first

After the backend is live, open these URLs in a browser. They are diagnostics only:

1. Health: https://trc20-usdt-token-cloner-api.onrender.com/health
2. General readiness: https://trc20-usdt-token-cloner-api.onrender.com/api/readiness
3. Global production sponsorship capability (must remain disabled pending full go-live gates): https://trc20-usdt-token-cloner-api.onrender.com/api/tron/sponsorship/status
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

## 7. What is still needed before a controlled testnet transfer can be called complete

The current Render flag value is unverified, and the source-code signing/broadcast gate remains hard-closed. A resource ledger and a dual-provider historical delegation cross-check are implemented in the draft branch, but the cross-check is not cryptographic proof and no funded Shasta/Nile end-to-end pilot has been recorded. Do not claim a transfer has been sent or enable the source gate until the remaining independent evidence, review, database restore rehearsal, and controlled pilot are complete.

A transfer can be called complete only when the live test proves: a real sponsor-authorized and funded testnet transaction; persisted intent and replay/idempotency checks; successful solidified transaction body and receipt matching the exact sender/receiver/token/amount; receiver balance read on the same network and contract; separately reconciled fee/resource expense; failure/timeout handling; and an operator review of the audit trail. If any gate fails, do not force the transaction through by changing unrelated flags. If any outcome is ambiguous, reconcile the same stored intent and transaction ID; never retry with a different key or transaction just to make the UI appear successful. The application must not deduct the transfer principal from the receiver's amount and must never fall back to charging the sender.

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


## 12. TRONGrid resource-read provider selection

The sponsor resource reader supports the official TRON node API through TRONGrid for the configured network:

- Mainnet: `https://api.trongrid.io`
- Shasta: `https://api.shasta.trongrid.io`
- Nile: `https://nile.trongrid.io`

When `TRONGRID_API_KEY` is configured on the **backend Render Web Service**, resource-read requests try authenticated TRONGrid first with the `TRON-PRO-API-KEY` header, then the configured Tatum provider per endpoint if needed. If the TRONGrid key is absent, the reader tries configured Tatum first and then falls back to public TRONGrid read-only endpoints; if neither key is present, it can attempt public TRONGrid directly. Public requests may be severely rate-limited or rejected, so configure a server-only `TRONGRID_API_KEY` for reliable operation. `TATUM_API_KEY` and `TRONGRID_API_KEY` belong only in backend Render environment variables and must never be exposed in frontend `VITE_*` variables. This is only a read-path provider choice; it does not change transaction submission, signing, sponsor consent, or budget activation. Keep provider keys private and rotate them through provider consoles if exposed.

For a controlled diagnostic, query the Nile and Shasta pilot preflight endpoints in section 4 with `refresh=1`. Confirm the reported resource read succeeds and inspect only the sanitized status fields. TRON's `getaccountresource` reports aggregate resource limits and usage; it does not by itself prove that a specific sponsor has delegated resources to the intended recipient. A delegation check and solidified on-chain evidence are still required. See the [official TRON GetAccountResource reference](https://developers.tron.network/reference/getaccountresource) and [Account Resources overview](https://developers.tron.network/reference/account-resources).

If resource diagnostics still fail, record the network, HTTP status/category, and failure stage without logging request headers, API keys, full environment values, or sponsor addresses. Do not treat provider reachability as proof of sufficient resources or as permission to submit a transaction.


## 13. Frontend wallet sign-in and token contract selection

The main workflow has a top-bar **Sign in with TronLink** action. Select Nile or Shasta first, then use the wallet that owns the address you want to identify with. TronLink signs a short-lived, human-readable login challenge; the backend verifies that the recovered signer equals the requested address. This is wallet-ownership proof, not a transaction signature and not sponsor-spending authorization. A public address alone is not login proof.

Do not enter a private key, seed phrase, or recovery phrase in the website. The app intentionally has no private-key login field. There is no separate password account-creation flow: the public address plus a verified message signature is the current identity model. Current auth sessions are memory-only, expire, and are invalidated if the API service restarts, so users may need to sign in again. Do not rely on this ephemeral identity session for a persistent production user profile.

For a custom token, open the main transfer workflow, choose **TRC-20 test token**, and enter the contract address for the selected testnet. The frontend stores a structurally valid contract address locally in that browser, separately for Nile and Shasta, to avoid repeated entry. This browser preference is not a token approval and is not shared across devices. Backend network-specific contract allowlists remain authoritative for any sponsored reservation or transfer. If an address is not allowlisted, stop and have the operator review the exact network/contract before changing backend configuration. Do not use Mainnet USDT's address as if it were a testnet token contract, and do not label an unrelated token such as VTRC as official Tether USDT.

The Sponsor Operator Console must use the token contract and amount already fixed in the approved reservation. Do not edit the contract after reservation creation to try to make the signature fit another intent. When switching between distinct fee-sponsor and asset-principal accounts, TronLink has only one active signing account at a time: role snapshots remain visible for reference, but the relevant owner must reselect/reconnect their own account before signing. The console verifies the current account/network immediately before each wallet signature.

If readiness still reports `fee-sponsor-resource-capacity-not-verified` or `active-fee-to-principal-resource-delegation-not-verified`, the transfer remains blocked even when the asset-principal account has a positive TRX balance. A separate fee sponsor with zero TRX and no observed delegation cannot cover required fees by UI changes alone. Fund/stake the authorized fee sponsor or configure the actual authorized fee-resource arrangement, then repeat the solidified resource/delegation checks. Do not mark a transaction sent until a real node transaction ID is returned and the exact transaction/receipt/event and receiver balance are verified.

## 14. Troubleshooting wallet login and switching sponsor accounts

The frontend now checks the modern TronLink provider first (`window.tron`) and falls back to the legacy alias (`window.tronLink`). It requests account access with `eth_requestAccounts` first and uses `tron_requestAccounts` only if that method is unsupported. Do not require `tronWeb` to exist before requesting authorization; inspect it after the request has been approved.

### Recommended browser flow

1. Open the frontend in a browser where the TronLink extension is enabled, or in a compatible wallet browser. Choose the same testnet in the wallet and in the app (Nile or Shasta).
2. Choose **Connect & sign in with TronLink** and approve the account request. Then inspect the human-readable **TRON Token Studio wallet sign-in** challenge. Approve that message signature only if its address, testnet, origin and identity-only purpose are expected. This signs a login message, not a transfer.
3. If using a normal browser without the wallet provider, choose **Continue in watch-only mode**. This allows public address and token-contract inspection in the main workspace, but it does not authenticate address ownership, sign, broadcast, or open the sponsor operator console.
4. When switching between asset-principal and fee-sponsor wallets, use TronLink's account selector and reconnect the corresponding role in the console. The site identity session and selected signing account are separate. Each signing operation must still verify the active account and testnet immediately before the wallet prompt.

### Common failures and their interpretation

- **TronLink not detected:** the current browser context did not expose a supported injected provider. Open/enable the wallet or use watch-only inspection.
- **A wallet request is already open:** finish or dismiss the existing prompt before retrying. Repeated clicks can stack up pending wallet requests.
- **User rejected / confirmation declined:** the request was rejected by the wallet. No signature or broadcast should be inferred from this result.
- **Wallet locked / user has not unlocked wallet:** unlock the wallet, select the intended account and retry.
- **Network mismatch:** select the exact Nile or Shasta network in both the app and wallet. The app does not switch chains automatically.
- `origin-not-allowed` from the auth API: check the backend's server-only `FRONTEND_ORIGIN` setting includes the exact deployed frontend origin (scheme and host, no path). Save/deploy the backend configuration before retesting. Never expose other backend secrets to the browser.
- **Signature verification failed / address mismatch:** confirm that the wallet approved the displayed challenge and kept the same account selected until the verify request completed. Reload and request a fresh challenge; challenges are short-lived and single-use.

The session store for wallet login is currently in application memory and sessions expire; a backend restart invalidates existing sessions. This must not be described as a permanent password account. A public TRON address alone is suitable for watch-only lookup, not proof of identity.

### Reservation idempotency key reminder

The console's **Reservation idempotency key** is the exact key created by the trusted reservation CLI or returned from the protected transfer ledger. It is not a transaction hash, wallet address, sponsor reference, or any wallet secret. The key cannot create/approve a reservation when pasted into the console. Use [the reservation idempotency guide](./SPONSOR_RESERVATION_IDEMPOTENCY.md) to create or locate an approved reservation, and stop if the console reports `transfer-not-found`.

Neither a successful sign-in, a connected wallet, nor a visible sponsor balance means a transaction was signed or sent. Report a transfer as completed only after the exact transaction is visible in solidified chain data with the expected sender, receiver, token contract, amount and successful execution. Exchange-account credit remains an exchange-side status.
