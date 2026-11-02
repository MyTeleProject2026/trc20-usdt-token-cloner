# Owner-Only Treasury-Funded USDT Withdrawals

## Purpose and hard limits

This design lets the single authorized Tron Token Studio owner request withdrawals from a platform treasury without personally holding the USDT in the app's local wallet. The treasury must hold the actual USDT principal on TRON. Fee sponsorship can pay network costs, but it cannot supply the USDT principal. There is no implementation that creates genuine USDT from a locally generated balance.

A transaction must never be described as paid, confirmed, or exchange-credited until the relevant evidence exists. A chain-confirmed transfer does not guarantee that a centralized exchange credited a deposit.


## Recipient approval and execution-status rules

Recipient authorization supports two independent sponsor-controlled policies:

- **Static sponsor allowlist:** `TREASURY_ALLOWED_RECIPIENT_ADDRESSES` is a comma-separated list of 1–100 unique, checksum-valid TRON Base58Check addresses. Every new entry still requires documented sponsor approval and a controlled backend configuration change.
- **Sponsor-signed approval registry:** `TREASURY_SPONSOR_APPROVER_ADDRESSES` is a comma-separated list of 1–20 unique, checksum-valid TRON addresses controlled by the sponsor organization. It must not include the platform owner or treasury address. Any signer in this configured list may approve or revoke an exact recipient request; the backend recovers the signer from the TRON message signature and checks that it is on this independent sponsor list. Supplying this variable is a sponsor-admin operation, not a value the platform owner can self-assign.

The sponsor-signed lifecycle is exposed under the treasury API:
- `POST /api/treasury/recipient-approval-requests`: an authenticated owner creates a request with an exact recipient address and a single-line reason. The server binds the request to the current sponsor organization, agreement, treasury source, official Mainnet USDT contract, requesting owner, configured origin, unique request ID, and a 24-hour expiry. The response contains the canonical text that the sponsor signer must inspect and sign.
- `GET /api/treasury/recipient-approval-requests/:requestId`: retrieves the pending approval message, or the revocation message for an approved request.
- `POST /api/treasury/recipient-approval-requests/:requestId/approve`: accepts only the signature of a currently configured sponsor approver over the exact canonical approval message. The backend checks the message hash, expiry, and the agreement/treasury/token scope again before persisting the approval.
- `POST /api/treasury/recipient-approval-requests/:requestId/revoke`: accepts only a sponsor-approver signature over a separate revocation message bound to the original approval hash. Revoked entries no longer authorize new withdrawals.

The payout reservation transaction locks the approved registry row while it re-verifies the stored message hash and sponsor signature, so a concurrent revocation cannot slip between approval verification and reservation. A recipient is accepted only through the static allowlist or a currently active, cryptographically verified sponsor-signed record for the exact organization, agreement, treasury and Mainnet USDT contract. An owner wallet signature on a normal withdrawal request is not sponsor approval.

These API routes are backend-ready but do not yet provide a dedicated sponsor-facing UI or wallet-signing screen. A sponsor operator must use a trusted wallet/tool under the sponsor organization's own controls to inspect and sign the canonical approval or revocation message, then submit the signature to the matching endpoint. Never ask the platform owner to impersonate the sponsor or paste a sponsor private key into the service.

Readiness has two distinct meanings:
- `payoutsPreflightReady` / `preflightChecksPassed`: configuration, provider metadata, balances, fee reserve, database and sponsor-budget checks passed.
- `withdrawalsEnabled` / `executionEnabled`: the server is actually permitted to submit real-value withdrawals. In supervised builds this remains `false` while the immutable execution lock is closed, even when preflight is otherwise complete.

The UI must not label a successful preflight as an active withdrawal capability. Environment feature flags, a positive balance, a Fireblocks API response, or a successful readiness request cannot override the server-side release lock.

## Sponsor recipient signer environment

Set `TREASURY_SPONSOR_APPROVER_ADDRESSES` only after the actual sponsor organization has independently verified and authorized its sponsor approver wallet(s). The values are public TRON addresses, not private keys. The configured approver set must remain separate from `OWNER_WALLET_ADDRESS`, `TREASURY_OWNER_ADDRESS`, and the treasury source address. Changes to this set are controlled sponsor-policy changes and require renewed review; the API does not allow the owner console to add approver addresses.

A sponsor approval signature is a policy authorization only. It does not sign a Fireblocks transaction or transfer USDT. A payout still requires the separately authenticated owner session, a one-request owner signature, approved sponsor agreement scope, remaining principal commitment, genuine USDT and fee balances, Fireblocks policy approval, reservation/idempotency controls, and independent on-chain receipt verification.

## Authorization model

"Without per-transfer approval" means pre-authorized automation under an owner-configured policy, not spending without authorization:

- The owner explicitly configures and signs off on the policy once.
- Every payout requires a valid authenticated owner session and a unique idempotency key.
- Enforce recipient allowlists or a policy-defined address review period. New-recipient approval must come from an independent sponsor-controlled signer or from the sponsor's controlled static configuration process.
- Enforce per-transfer, daily, and rolling-window limits.
- Require an independent second factor or delayed approval for policy changes, new recipients, and high-value payouts.
- Reject replayed requests and use an atomic reservation/ledger update before attempting broadcast.
- Pause withdrawals on a policy change, balance mismatch, provider outage, suspicious activity, or reconciliation failure.
- Keep an append-only audit trail without storing private keys, seed phrases, or raw session tokens.

A wallet sign-in proves control of an address; it does not by itself authorize spending treasury funds. Never use the wallet-auth session as a substitute for the payout policy or treasury signing authorization.

## Suggested architecture

1. **Owner console:** configure allowed network (Mainnet for real USDT), official token contract, recipient policy, spending limits, pause switch, and payout notifications.
2. **Withdrawal request API:** validate the authenticated owner, address, amount, policy, replay/idempotency, and rate limits. Return a request ID; do not trust client-supplied balance or transaction status.
3. **Treasury balance check:** query a fixed TRON provider and verify the actual token contract and current on-chain USDT balance. Check native TRX or a supported fee-sponsor path separately.
4. **Policy engine:** reserve funds atomically and reject requests that exceed available treasury funds or configured limits.
5. **Signing boundary:** use a dedicated signer, managed custody provider, or multisig workflow. Do not put a treasury private key in frontend code, APK resources, ordinary Render environment variables, logs, or API responses. The signer must enforce the same policy independently.
6. **Broadcast and verification:** broadcast only the signed transfer, save the returned transaction ID, and independently verify sender, recipient, official contract, base-unit amount, successful contract receipt, and solidification.
7. **Reconciliation:** reconcile reservations against on-chain transactions; mark uncertain outcomes as pending and never automatically retry a transfer whose broadcast outcome is ambiguous.
8. **Recipient status:** show "on-chain confirmed" separately from "exchange deposit credited". Exchange credit can only be verified from the exchange's authorized records or by the recipient.

## Legitimate funding sources

- Transfer genuine USDT from an owner-controlled wallet or exchange withdrawal to the treasury address.
- Fund the treasury from documented platform revenue or capital.
- Use a regulated, contractually authorized payment/custody provider that actually supplies or settles the USDT.
- Use a properly documented OTC/corporate treasury arrangement where applicable.
- Use testnet tokens for development-only tests.

A gas-sponsorship provider may cover eligible transaction fees under its terms, but this does not fund the token amount. Never rely on fabricated balances, unofficial tokens labeled as USDT, forged transaction hashes, or attempts to make exchanges display unbacked deposits.

## Operational readiness checklist

- [ ] Owner identity and account recovery are secured.
- [ ] Treasury address is verified out of band and displayed read-only.
- [ ] Official TRON USDT contract is pinned: `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`.
- [ ] Mainnet treasury balance and fee path are verified from chain data.
- [ ] Signing is isolated from the public API and protected by an independent policy.
- [ ] Limits, recipient rules, idempotency, rate limiting, and pause controls are tested.
- [ ] Tests cover insufficient funds, replay, concurrent requests, failed/ambiguous broadcasts, wrong token contracts, and false-positive receipts.
- [ ] No Mainnet payout is enabled until independent security review and end-to-end tests pass.
- [ ] The owner understands that deployment, API credentials, provider access, and a funded treasury are required; source code alone does not fund transactions.

## Current feature-branch integration status (2026-10-29)

The main branch includes the single-owner login gate, treasury balance reads, per-request owner signature, database reservations, payout caps, an idempotency ledger, and independent on-chain receipt verification. The USDT and native-TRX payout paths use a managed Fireblocks vault signer instead of loading the treasury's blockchain private key into the application. Both paths require `FIREBLOCKS_TRX_ASSET_ID` so fee funds can be checked against provider metadata and the matching vault address; USDT readiness and submission reserve one maximum fee cap for every unresolved USDT/TRX request plus the proposed payout.

The managed USDT route expects:
- `TREASURY_SPONSOR_ORGANIZATION_REFERENCE`, `TREASURY_SPONSOR_AGREEMENT_REFERENCE`, and `TREASURY_SPONSOR_TOTAL_BUDGET_USDT` must match a real executed sponsor agreement. The agreement reference must also have an exact Mainnet `USDT` / `asset-grant` allowlist scope bound to the configured Fireblocks vault address and official TRON USDT contract; a Nile/Shasta scope or different sponsor address cannot authorize the Mainnet route. The agreement references are stored on every withdrawal row; the total commitment is consumed by confirmed payouts and unresolved reservations. Changing the agreement reference does not reclassify old rows. Missing or malformed references, or a total budget below either the per-transfer or daily cap, fails configuration validation.
- `TREASURY_SIGNER_MODE=fireblocks`, `TREASURY_WITHDRAWALS_ENABLED=true` only after review, and the existing single owner address configuration.
- Fireblocks API key ID, an absolute path to a mounted Fireblocks **API-authentication** RSA secret file, an existing vault account ID, and the provider's asset ID.
- Provider metadata that matches the official TRON Tether USDT contract, exactly one provider-returned source address matching `TREASURY_ADDRESS`, and both provider-available and on-chain USDT covering the requested principal. `FIREBLOCKS_TRX_ASSET_ID` must identify native TRX with six decimals and no token contract; both provider-available and on-chain TRX must cover one maximum fee cap per unresolved USDT/TRX payout plus the proposed payout.
- Fireblocks' own transaction policy configured to require appropriate authorization/approval, with separate destination and spending controls.
- A written, separately signed third-party treasury sponsorship agreement, identified by TREASURY_SPONSOR_ORGANIZATION_REFERENCE and TREASURY_SPONSOR_AGREEMENT_REFERENCE, and an exact `SPONSOR_APPROVED_AGREEMENT_REFERENCES` entry matching the organization reference, `mainnet`, the verified Fireblocks vault address, `asset-grant`, `USDT`, and the official Tether contract.
- TREASURY_SPONSOR_TOTAL_BUDGET_USDT records the agreement's total USDT principal commitment. It is enforced against confirmed payouts plus unresolved reservations, independently of the per-payout and daily caps.
- `TREASURY_ALLOWED_RECIPIENT_ADDRESSES` is an optional comma-separated list of 1–100 unique, checksum-valid TRON Base58Check addresses. `TREASURY_SPONSOR_APPROVER_ADDRESSES` is an alternative or additive list of 1–20 independent sponsor-controlled TRON signer addresses. At least one of these two destination policies must be valid. If both are configured the mode is mixed. The dynamic signer list supports one authorized sponsor signature from any configured signer; it is not an M-of-N quorum. The sponsor organization must separately configure its Fireblocks destination policy and any required multi-person approval there.

The code uses a provider transaction ID and `externalTxId` to reconcile ambiguous submissions. It does not treat provider acceptance as chain confirmation. A Fireblocks terminal failure without an independently verified TRON transaction and solidified receipt remains `broadcast-unknown`; the principal reservation is retained instead of being released based only on the provider status. No Mainnet payout is considered confirmed until the independent verifier validates the real transaction, sender, recipient, amount, official USDT contract, successful solidified receipt, and Transfer event.

The sponsor agreement identifiers and configured aggregate budget are application controls and audit labels; they do not establish that a sponsor has legally agreed, that the Fireblocks policy requires sponsor approval, or that the vault is funded. The organization must verify those facts independently and retain the signed agreement and Fireblocks policy evidence.

The feature branch is code integration, not a live provider setup. No Fireblocks credentials were available during implementation, so there has been no authenticated provider call, no live asset metadata check, no funded Mainnet payout, and no exchange deposit credit test. Keep the withdrawal feature disabled until the operator installs the provider credential as a backend secret file, configures the real vault and policy, validates the balance endpoints, and completes a small controlled end-to-end transfer. Never paste API credentials or key files into chat or source control.


The aggregate principal cap is snapshotted in each new withdrawal reservation. Future requests under the same organization/agreement reference must match that stored cap. A changed environment cap, or older same-agreement rows without a cap snapshot, blocks further reservations. A different commitment requires a genuinely new written agreement and a new exact allowlist reference; do not reuse an agreement identifier to increase a commitment.
