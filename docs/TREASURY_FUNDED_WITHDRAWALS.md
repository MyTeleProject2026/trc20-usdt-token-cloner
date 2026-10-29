# Owner-Only Treasury-Funded USDT Withdrawals

## Purpose and hard limits

This design lets the single authorized Tron Token Studio owner request withdrawals from a platform treasury without personally holding the USDT in the app's local wallet. The treasury must hold the actual USDT principal on TRON. Fee sponsorship can pay network costs, but it cannot supply the USDT principal. There is no implementation that creates genuine USDT from a locally generated balance.

A transaction must never be described as paid, confirmed, or exchange-credited until the relevant evidence exists. A chain-confirmed transfer does not guarantee that a centralized exchange credited a deposit.

## Authorization model

"Without per-transfer approval" means pre-authorized automation under an owner-configured policy, not spending without authorization:

- The owner explicitly configures and signs off on the policy once.
- Every payout requires a valid authenticated owner session and a unique idempotency key.
- Enforce recipient allowlists or a policy-defined address review period.
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

The main branch includes the single-owner login gate, treasury balance reads, per-request owner signature, database reservations, payout caps, an idempotency ledger, and independent on-chain receipt verification. The USDT and native-TRX payout paths use a managed Fireblocks vault signer instead of loading the treasury's blockchain private key into the application. Native TRX uses a separate configured provider asset ID and requires exact native-asset metadata plus a matching Fireblocks vault address.

The managed USDT route expects:
- `TREASURY_SIGNER_MODE=fireblocks`, `TREASURY_WITHDRAWALS_ENABLED=true` only after review, and the existing single owner address configuration.
- Fireblocks API key ID, an absolute path to a mounted Fireblocks **API-authentication** RSA secret file, an existing vault account ID, and the provider's asset ID.
- Provider metadata that matches the official TRON Tether USDT contract, exactly one provider-returned source address matching `TREASURY_ADDRESS`, provider available balance and public chain balance sufficient for the requested principal, and a TRX balance covering the configured fee cap.
- Fireblocks' own transaction policy configured to require appropriate authorization/approval, with separate destination and spending controls.

The code uses a provider transaction ID and `externalTxId` to reconcile ambiguous submissions. It does not treat provider acceptance as chain confirmation. No Mainnet payout is considered confirmed until the independent verifier validates the real transaction, sender, recipient, amount, official USDT contract, successful solidified receipt, and Transfer event.

The feature branch is code integration, not a live provider setup. No Fireblocks credentials were available during implementation, so there has been no authenticated provider call, no live asset metadata check, no funded Mainnet payout, and no exchange deposit credit test. Keep the withdrawal feature disabled until the operator installs the provider credential as a backend secret file, configures the real vault and policy, validates the balance endpoints, and completes a small controlled end-to-end transfer. Never paste API credentials or key files into chat or source control.
