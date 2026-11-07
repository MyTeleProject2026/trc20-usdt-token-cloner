# Sponsor Organization Legacy Fincra Mandate Disable

## Scope

This change hard-disables the legacy `fincra-automatic` execution mode in the organization mandate API. It is a non-operational application-layer change. It does not contact Fincra, inspect provider credentials, alter external accounts, sign, create transactions, broadcast, or move funds.

## Behavior after this change

- `GET /organizations/config` advertises only `per-transfer` in `supportedExecutionModes`.
- The `FINCRA_AUTO_PAYOUTS_ENABLED` status indicator is removed. The onboarding route no longer reads `FINCRA_AUTO_PAYOUTS_ENABLED` or `FINCRA_BUSINESS_ID`.
- New mandate submissions accept only `per-transfer`. Legacy provider fields are not accepted in the request schema.
- The sponsor onboarding UI no longer offers the legacy mode, sends provider-specific mandate fields, or presents a Fincra business-ID authorization option. Historical legacy rows are labeled disabled; owner review controls do not offer verification or authorization for them.
- The signed mandate message states `Execution mode: per-transfer` and contains no standing Fincra authorization terms.
- Existing historical rows whose `execution_mode` is `fincra-automatic` are preserved; startup does not rewrite or delete them.
- The legacy review route refuses to verify or authorize a historical non-`per-transfer` mandate and returns `legacy-mandate-execution-mode-disabled`. The record may be declined through review or revoked by its sponsor.
- The database check constraint continues to recognize the historical value so existing records remain readable. This is a compatibility allowance, not an enabled API mode.

## Safety invariants

- Organization onboarding and mandate responses continue to report `payoutAuthorized: false`.
- The Stage 6 evidence evaluator remains disconnected from payout execution.
- Existing sponsor-direct, owner-direct and treasury Mainnet broadcast/execution guards are unchanged.
- The 1,000 USDT platform withdrawal minimum is unchanged.
- No production database migration or data rewrite was run.

## Regression coverage

`tests/sponsor-organization-fincra-mode-disabled.test.mjs` checks the config response contract, request rejection, historical mandate review blocking, and preservation of historical rows without destructive startup rewriting. CI must pass on the resulting PR head before this stage is considered verified.
