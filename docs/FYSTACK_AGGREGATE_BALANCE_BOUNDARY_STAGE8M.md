# Stage 8M — FYStack aggregate-balance boundary and payout authorization

## Scope

Read-only contract clarification for FYStack's workspace USDT balance observation. No provider write API, wallet operation, approval, credit request, policy update, signing, or broadcast is introduced.

## Official API facts reviewed 2026-11-11

- FYStack documents workspace balance/analytics resources and the workspace USDT balances endpoint used by `server/fystack-workspace-balance-reader.mjs`.
- The current public documentation and inspected SDK surface do not establish a wallet-specific available/held USDT balance contract suitable for payout authorization.
- The workspace balance response is aggregate across wallets and reports network-level observations. It does not establish which wallet owns the balance, the TRC20 contract identity for a given balance row, or whether funds are available rather than held.
- FYStack's withdrawal API documents a state-changing request endpoint and a withdrawal status lookup. Creating a withdrawal request is not a credit facility, not a balance source, and not proof that the requested amount can be paid.
- FYStack's withdrawal guidance states that network fees are paid from the native gas token. The Gas Station product uses a shared Gas Tank; a gas sponsorship setting is not itself a funded gas balance.

References:
- https://docs.fystack.io/
- https://docs.fystack.io/changelog
- https://docs.fystack.io/withdrawals
- https://docs.fystack.io/product/withdrawal
- https://docs.fystack.io/product/approval-group
- https://docs.fystack.io/product/asset-management
- https://github.com/fystack/platform-sdk

## Implementation decision

Keep `getWorkspaceUsdtBalances()` strictly observational. Its output must never be converted to wallet-specific available USDT, Tron Transfer spendable balance, provider credit, payout authorization, or execution readiness.

A future wallet-liquidity adapter requires an authoritative provider response with all of:
- exact workspace and wallet IDs;
- official TRON Mainnet network identity;
- official TRC20 USDT contract and decimals;
- available and held/reserved quantities separately;
- response timestamp and documented freshness;
- authenticated provider response and documented API entitlement.

A future gas adapter separately requires the actual TRON gas resource balance/availability and an authorized, funded sponsorship or rental arrangement. A UI toggle alone is insufficient.

## Tests and invariants

The workspace observation tests explicitly assert:
- workspace aggregate scope only;
- no wallet-specific or available balance verification;
- no token-contract verification;
- no credit approval or payout authorization;
- no ledger mutation;
- execution remains disabled.

The 1,000 USDT minimum remains unchanged. No real provider API call was made, no provider credential was used, no funds were moved, and no merge or deployment was performed.
