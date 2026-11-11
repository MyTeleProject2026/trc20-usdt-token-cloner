# Stage 8I — FYStack SDK surface audit (read-only)

Audited PR #151 parent HEAD: `f0727409917a9589125f3b1a2b30c0d5144c9956`.

## Source inspected

Official public SDK repository:
- https://github.com/fystack/platform-sdk
- https://github.com/fystack/platform-sdk/blob/master/readme.md
- https://github.com/fystack/platform-sdk/blob/master/src/sdk.ts
- https://github.com/fystack/platform-sdk/blob/master/src/api.ts
- https://github.com/fystack/platform-sdk/blob/master/src/types.ts

SDK package metadata identifies `@fystack/sdk` version 0.2.0 at the inspected repository revision.

## Confirmed read-only SDK surface

The SDK source exposes:
- `sdk.getWallets()` — workspace wallet listing.
- `sdk.getWalletAssets(walletId)` — wallet asset metadata/deposit-address records.
- `sdk.getDepositAddress(walletId, addressType)` and `sdk.getDepositAddressByAssetId(walletId, assetId)`.
- `sdk.getWithdrawalStatus(walletId, withdrawalId)` — withdrawal status lookup.

Important limitation: the inspected `WalletAsset` TypeScript interface contains wallet ID, asset ID, deposit address, hidden flag, and asset metadata. It does **not** define a balance field. The reviewed SDK source does not expose a dedicated wallet-asset balance getter. Therefore `getWalletAssets()` must not be misrepresented as a balance endpoint, and no balance can be safely populated from it.

## Confirmed state-changing surface — excluded

The SDK also exposes `sdk.requestWithdrawal(walletId, params)`. This creates a withdrawal request and may trigger provider approval/policy processing. It is state-changing and is not called, wired into Tron Transfer, or enabled by this stage.

The SDK README describes wallet creation and deposit-address retrieval. It documents requestWithdrawal and getWithdrawalStatus. No assumption is made that this workspace has API credentials, Production access, sufficient balance, an enabled TRON USDT withdrawal asset, gas sponsorship, credit approval, or payout permission.

## Integration decision

Stage 8G's `getWalletUsdtSnapshot` remains an injected placeholder contract; it is not an SDK method. A production balance adapter is blocked until FYStack supplies or documents a supported balance source with an explicit response schema and available/held semantics. Acceptable evidence must distinguish:
- total token balance;
- available balance;
- held/reserved balance;
- token contract and network;
- wallet and workspace identity;
- snapshot timestamp and freshness.

Do not derive balance from dashboard USD value, top-assets summaries, deposit-address metadata, or withdrawal history.

## Security and policy gates

- SDK credentials must be server-side only. Never place API keys, API secrets, Ed25519 private keys, cosigner material, or recovery phrases in frontend code, chat, logs, or commits.
- Keep any future provider read-only client separate from withdrawal request/signing functionality.
- Do not create policy ALLOW rules or reduce approval thresholds as an integration workaround.
- A provider withdrawal request is not proof of credit or free funding; a funded and authorized source is still required.

## Preserved invariants

- No FYStack API request was sent.
- No SDK dependency was installed or added.
- No wallet, asset, policy, credential, approval, or withdrawal was created or changed.
- No database migration or historical-record mutation.
- The 1,000 USDT minimum remains unchanged.
- No provider balance is credited to Tron Transfer or treated as spendable.
- Signing, broadcasting, sweeping, and transfers remain disabled.
- No merge or deployment.

## Exit criteria

Before any future read-only adapter implementation: obtain FYStack's documented balance endpoint or explicit provider confirmation of an equivalent SDK method and response schema; confirm workspace API access, environment, wallet ID, TRON Mainnet USDT asset ID/contract, and server-side credential provisioning. Test stale responses, held-versus-available amounts, wrong network/contract, identity mismatch, and provider outage with fixtures only.
