# Step 4 — testnet end-to-end testing status

**Audit date:** 2026-10-30  
**Repository:** `MyTeleProject2026/trc20-usdt-token-cloner`  
**Scope:** Nile/Shasta testnet only. This document records actual evidence and remaining gates; it is not a claim that a live transaction has completed.

## Current verified evidence

- GitHub CI test/build, dependency audit, and Node.js 22/24 build-and-contract matrix passed on the latest audited source state. See [CI #40952127414](https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/actions/runs/40952127414), [dependency audit #40952127433](https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/actions/runs/40952127433), and [Node matrix #40952127643](https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/actions/runs/40952127643).
- Public API smoke run [#40951784898](https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/actions/runs/40951784898) passed after the last backend environment update. It verified API health/readiness and that sponsor submission remains disabled.
- The deployed dual-testnet preflight previously reported nine blockers on each of Nile and Shasta. The fee sponsor and asset-principal sponsor addresses were not configured, and sponsor funding/resources/delegation and post-transfer settlement were not verified.
- The live preflight endpoint is read-only: `GET /api/tron/sponsorship/testnet-pilot-readiness?network=both&refresh=1`. Its contract always reports `submission.enabled=false`, `canSubmitSponsoredTransfer=false`, and `userFundedFallbackAllowed=false`. A preflight response is not a transaction.
- Existing automated tests cover the route gates, intent validation, signature/transaction identity checks, and settlement/reconciliation logic in isolated tests. These are not proof of a successful live Nile/Shasta sponsor transfer.

## Reproducible read-only preflight command

The repository now provides `npm run testnet:preflight` via `scripts/run-testnet-preflight.mjs`. It makes GET-only requests to the health, dependency-readiness, sponsorship-status, integration-readiness, and dual-testnet pilot endpoints. It writes a sanitized `testnet-preflight-report.json` suitable for review.

To inspect a non-default HTTPS API deployment, set `TESTNET_PREFLIGHT_API_BASE_URL` to its HTTPS origin. The script rejects URLs containing credentials, paths, queries, fragments, or non-HTTPS schemes. It reports only allowlisted health/configuration/readiness fields and blocker codes; it does not save raw provider responses, public sponsor addresses, API secrets, or database URLs. Its tests cover GET-only behavior, sanitization, unsafe submission-gate detection, and transport failures.

This command is a **diagnostic improvement, not a sponsored-transfer implementation or live end-to-end transaction**. The report deliberately keeps `step4Complete=false` and `liveTransferEvidenceRecorded=false`. It does not sign, broadcast, reserve a funded budget, or claim receiver settlement. The existing production and user-funded-fallback gates must remain closed until the external sponsor prerequisites and real chain evidence below are satisfied.

## Step 4 verdict

**Status: NOT COMPLETE — live testnet transaction and settlement evidence are missing.**

No live testnet transfer is claimed here. The currently recorded evidence does not establish sponsor consent, two distinct sponsor roles, funded testnet accounts, approved reservation/budget, active resource delegation, a real signed/broadcast transaction, solidified receipt, exact token event, receiver balance delta, or settled sponsor cost. Do not report a payout as complete based only on UI state, a passing build, a readiness response, or a transaction ID that has not been independently verified.

## Controlled testnet acceptance criteria

Keep the testnet isolated from Mainnet and use a clearly labelled test token with the exact testnet contract; never describe a test token as official Mainnet USDT.

1. **Sponsor authorization:** obtain a real, documented approval from the owners of the fee/resource sponsor and asset-principal sponsor. The approval must state the network, exact token contract/asset, recipient policy, maximum principal, fee cap, expiry, and stop authority.
2. **Safe configuration:** configure only public testnet addresses and server-side secrets in the backend service. Never place seed phrases, private keys, wallet passwords, or admin tokens in source control, frontend variables, screenshots, or chat. Keep Mainnet submission and user-funded fallback disabled.
3. **Live read-only preflight:** check `/health`, `/api/readiness`, `/api/tron/sponsorship/status`, `/api/tron/sponsorship/integration-readiness`, and the dual-testnet pilot endpoint. Confirm the intended testnet's solidified head, distinct sponsor roles, actual balances, resource capacity, and active fee-to-principal delegation. Stop if any blocker remains.
4. **Reservation and budget:** use the existing approved agreement scope and idempotency key. Confirm the stored network, sponsor, recipient, asset, contract, exact base-unit amount, cap, and reservation status. Reconcile any timeout against the same reservation; never create a second request to mask an ambiguous result.
5. **Human wallet approval:** the authorized asset-principal sponsor owner must inspect the exact transaction in the wallet on the same testnet and personally approve its signature. The fee/resource sponsor owner must separately approve any required delegation. Do not send or request wallet secrets through ChatGPT.
6. **Broadcast and finality:** only the explicitly authorized testnet route may broadcast the exact reviewed transaction. Record the transaction ID from the actual node/provider response; verify the solidified transaction body and successful receipt independently.
7. **Asset verification:** verify the exact sender, recipient, network, token contract, and base-unit amount in the actual TRC-20 `Transfer` event (or native TRX transfer as applicable). Re-read the receiver's balance from the same network and asset contract. Never infer an exchange deposit credit from a chain transfer.
8. **Cost settlement and replay/failure checks:** reconcile actual sponsor costs and resource consumption against the approved cap; verify idempotent duplicate behavior, timeout recovery, wrong-network rejection, failed transaction handling, and emergency pause. No user-funded fallback is permitted.
9. **Evidence review:** retain sanitized logs, the verified testnet transaction URL/hash, receipt/event evidence, before/after balance evidence, sponsor cost reconciliation, and operator sign-off. Redact API credentials and private information.

## Free-plan constraint

The project is to remain on Render Free because paid infrastructure is not currently affordable. This is acceptable for continued development and limited smoke testing, but not a guarantee of durable production operation. The existing Free Postgres instance is recorded as expiring on **2026-11-17** and Free services may sleep or have resource limits. Keep a safe, verified backup/export plan for non-sensitive application data and avoid treating the current database as durable storage. Do not create additional billable resources.

## Evidence to add only after a real run

- [ ] Approved sponsor scope and operator review reference verified privately.
- [ ] Fresh live preflight has no unresolved required blockers for the selected testnet.
- [ ] Exact reservation and budget were independently checked before signing.
- [ ] Authorized wallet signed the exact persisted transaction intent.
- [ ] Node accepted the real broadcast and returned the recorded transaction ID.
- [ ] Solidified successful receipt and exact event were independently verified.
- [ ] Receiver balance was re-read on the correct testnet/contract.
- [ ] Sponsor fee/resource cost and ledger settlement reconciled.
- [ ] Duplicate, timeout, failure, wrong-network and emergency-pause checks passed.
- [ ] Sanitized evidence reviewed and signed off.

Until every applicable item above has real evidence, Step 4 remains blocked and sponsored payouts must not be represented as live or complete.
