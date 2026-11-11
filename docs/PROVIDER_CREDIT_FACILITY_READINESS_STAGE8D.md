# Provider credit-facility readiness — Stage 8D

## Purpose

This stage separates four facts that must never be conflated:

1. A provider account exists.
2. A provider has explicitly approved a credit facility.
3. The approval explicitly permits the intended use.
4. A separately authorized and funded operational arrangement exists.

An account registration, API credential, wallet, MPC signer, provider product page, transaction-volume quota, or sandbox balance is not credit approval and is not spendable funding.

## Current state

Where the owner has provider accounts but no written or independently authenticated credit approval, the application must display:

- Provider account: account presence only (and only when independently established by a trusted read-only integration).
- Credit approval: **not provided**.
- Permitted use: **not documented**.
- Available credit: **unverified / unavailable**.
- Withdrawal execution: **disabled**.

The new pure helper `server/provider-credit-facility-readiness.mjs` classifies account and evidence-reference metadata. It deliberately treats references as unverified. It does not accept browser-supplied `approved`, `balance`, or `availableCreditBaseUnits` fields as authority.

## Required evidence dimensions

A future read-only provider integration would need independently authenticated evidence for each dimension:

- Provider legal identity and exact account identifier.
- Credit agreement or facility identifier, status, effective date and expiry.
- Explicit credit limit and currency, separately from monthly transaction-volume quotas.
- Permitted asset: official TRC20 USDT on TRON Mainnet.
- Permitted destination scope: external wallet and exchange deposit addresses, if expressly included.
- Beneficiary/platform identity and purpose restrictions.
- Per-transfer and aggregate limits, fees, repayment terms and revocation/suspension conditions.
- Provider-side evidence source, retrieval timestamp, freshness and integrity/authenticity verification.

A generic “crypto”, “digital asset”, “payout”, “wallet”, or “API access” permission must not be interpreted as permission for TRON Mainnet USDT withdrawals. Missing or ambiguous scope remains blocked.

## State model

| State | Meaning | Credit treated as spendable |
| --- | --- | --- |
| `no-provider-account` | No independently established provider account | No |
| `provider-account-only` | Account metadata exists; no approval evidence supplied | No |
| `approval-reference-only-unverified` | An approval reference is recorded; permitted use is absent | No |
| `evidence-references-recorded-unverified` | Both references exist, but neither is independently verified | No |
| `approved-and-scope-verified` | Reserved for a future independently authenticated review process; not emitted by this helper | No, not by this stage |

No state in this stage grants payout authorization or enables execution.

## Integration boundary

The helper is intentionally not wired to a payout route and cannot authorize a request. A future UI may consume its output only for status display. Provider API integration, evidence authentication, credit reservation, signing, broadcast, and settlement are outside this stage and remain disabled.

The platform minimum remains **1,000 USDT** (1,000,000,000 base units at six decimals). This stage does not alter withdrawal limits, migrations, existing records, provider accounts, environment variables, or production configuration.

## Verification

Run:

```sh
node --test tests/provider-credit-facility-readiness.test.mjs
```

The tests assert that an account alone is not approval, references remain unverified, browser-claimed approval/balance fields are ignored, and all outputs keep credit non-spendable and execution disabled.
