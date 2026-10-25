# Sponsor provider integration contract

## Current status

This contract prepares the next real provider adapter; it does not claim a signer, funded sponsor account, or broadcast path is connected. Runtime submission must remain fail-closed until a concrete provider is selected, credentials and sponsor consent are configured in the deployment secret manager, and a real testnet end-to-end test and security review pass.

Never commit or paste private keys, seed phrases, signing material, or provider secrets. Do not enable submission merely because environment variables exist, a provider is reachable, a balance snapshot exists, or preflight succeeds.

## Required server-side adapter

Implement one provider-specific module behind a narrow interface; do not put provider request details in browser code or route handlers. It must provide equivalents of:

- `getCapabilities({ network })`: read-only provider/version discovery.
- `getSponsorAccount({ network, sponsorId })`: account identity, funding and asset eligibility.
- `quote({ network, asset, tokenContract, amountBaseUnits, destination, memo, maxFeeBaseUnits })`: exact expiring quote; quoting does not authorize a transfer.
- `authorizeAndSubmit({ intent, authorization })`: accept only a validated intent and verifiable sponsor authorization; return a provider submission/trace ID only after acknowledged submission.
- `getSubmission({ network, providerSubmissionId })`: reconcile an uncertain timeout against the original submission; never create a replacement automatically.
- `getFinalizedResult({ network, providerSubmissionId })`: evidence for independent chain verification; provider-reported success alone is insufficient.
- `health()`: non-sensitive diagnostics, without credentials or raw upstream error bodies.

Schema-validate all provider responses. Unknown response shapes, invalid amounts, mismatched networks, expired quotes, missing IDs, and timeouts must fail closed. Never log authorization payloads or secret headers.

## Canonical transfer intent and authorization

The server-created intent must bind: immutable intent ID; idempotency key; network/chain ID; sponsor account; receiver and any required memo/tag; native TRX or exact allowlisted token contract; decimals and integer base-unit amount; separate principal and fee reservations; quote/provider reference and expiry; nonce; creation/authorization expiry; policy version; destination allowlist result; and sponsor/operator approval reference.

Authorization must be cryptographically verifiable and bound to the canonical intent. A boolean request field, client-supplied status, unsigned text, API-key presence, or database row is not authorization. Reject replayed nonces and duplicate keys whose intent bodies differ.

## Principal and fees are separate

The sponsor must cover the full receiver principal and approved network fee from sponsor resources. Reserve principal and fee budgets atomically in separate ledger entries. Never deduct fees from the requested principal or fall back to user funds. A fee-only gas-abstraction service must not be represented as funding TRX/USDT principal unless its documented, tested flow actually does so. Reject any intent where funding/fee behavior cannot guarantee the exact receiver amount.

## Durable states and reconciliation

1. `requested` -> `preflight-passed` only after fresh provider, balance, destination and policy checks.
2. `preflight-passed` -> `authorized` only after storing verifiable authorization, nonce, expiry and intent digest.
3. `authorized` -> `submitted` only after storing an acknowledged provider submission ID.
4. Ambiguous timeout -> `submission-unknown`; query the same provider record/idempotency key before retrying.
5. `submitted` -> `solidified-on-chain` only after independent solidified-chain verification of network, sender, receiver, exact amount, successful execution, and exact token contract/Transfer event for TRC-20.
6. `solidified-on-chain` -> `receiver-balance-reconciled` only after rereading solidified receiver balance and reconciling the delta.
7. `exchange-credited` only after an authenticated authoritative exchange deposit-status record confirms credit. Otherwise report chain confirmation only and state exchange credit is unverified.
8. Conflicting evidence -> `reconciliation-required`; pause spending against the affected reservation and alert the operator.

Do not release a reservation or submit a replacement while the original transaction outcome is uncertain.

## Required tests

- Authentication, secret redaction, supported/unsupported network and exact asset/token contracts.
- Quote expiry, decimal/amount overflow, wrong recipient, missing memo/tag and destination allowlist rejection.
- Missing sponsor funding, unavailable fee quote and insufficient separate budgets.
- Invalid/expired/wrong-intent/replayed authorization; concurrent duplicates; same key with different intent.
- Provider 4xx/5xx, malformed response, rate limit, pre-submit timeout and timeout after possible submission.
- Exact receiver principal; no user-funded fallback.
- Independent solidified TRX/TRC-20 verification, balance reconciliation and duplicate event handling.
- Exchange pending/failed/credited, unsupported asset/network and exchange API outage.
- Emergency pause blocks new submissions while preserving reconciliation for existing transactions.

Mocks are not end-to-end proof. Use a documented supported testnet and disposable test assets; retain sanitized evidence and actual test transaction IDs.

## Deployment release gate

1. Select and document the exact provider and supported networks/assets.
2. Provision a sponsor-controlled managed signer/MPC/HSM or provider authorization flow; never store raw private keys in the repo.
3. Configure least-privilege credentials and explicit sponsor consent/funding in the secret manager; verify funding independently on-chain.
4. Implement adapter, canonical intent verification, durable ledger, idempotency, independent verification, alerts and emergency pause.
5. Pass CI on an available runner and complete a real testnet end-to-end transaction.
6. Obtain operator/security approval and verify pause/rollback before enabling mainnet.
7. Enable only explicitly reviewed network/asset/destination combinations.

Until all gates pass, public status must continue to report `canSubmitSponsoredTransfer: false` and `submissionEnabled: false`. This is intentional fail-closed behavior, not a live integration claim.
