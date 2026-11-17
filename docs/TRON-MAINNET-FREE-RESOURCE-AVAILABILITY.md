# TRON Mainnet free resource availability and automation boundary

## Protocol facts

This implementation does not assume that TRON has a public faucet for deployment Energy.

The TRON Developer Hub documents these resource sources:

- Energy: stake TRX or receive a delegation from another account. There is no per-account free Energy quota.
- Bandwidth: stake TRX, receive a delegation, or use the account's renewable free Bandwidth quota (currently exposed by the chain parameter `getFreeNetLimit`; the protocol documentation currently describes 600 per activated account).
- Delegation requires a resource-owning account with delegatable Stake 2.0 resources. The owner of that stake remains the economic resource provider.
- Free Bandwidth and staked/delegated Bandwidth are not pooled to pay one transaction. A single source must cover the full transaction byte requirement; otherwise the protocol can burn TRX for the full Bandwidth cost.

Official references (check current chain parameters before relying on fixed values):

- https://developers.tron.network/docs/bandwidth-and-energy
- https://developers.tron.network/docs/delegation
- https://developers.tron.network/docs/paying-for-resources
- https://developers.tron.network/reference/getaccountresource

## Application behavior

1. Read fresh owner Energy, free Bandwidth, and staked/delegated Bandwidth independently.
2. Simulate the exact deployment transaction and compute the required Energy safety margin and serialized transaction Bandwidth.
3. Treat Bandwidth as covered only when either the free quota or staked/delegated quota independently covers the full transaction.
4. Permit an automatic provider claim only when an installed, explicitly authorized provider adapter reports exact-amount Mainnet eligibility and `userCostSun: "0"`.
5. Independently verify the provider's transaction, solidified successful receipt, exact delegation recipient/resource, and resulting owner resource coverage.
6. Block signing and broadcasting if any requirement is unknown, stale, short, or requires any TRX fallback.

## What is not currently available

The repository does not contain a verified official provider adapter that grants both Energy and Bandwidth to the configured owner for zero cost. TEnergy's public observer endpoints are read-only; its separate promotion is a one-time Energy-only campaign and must not be represented as a general deployment grant. Public resource observation or provider health is not grant authorization.

No public unauthenticated provider endpoint should be treated as a free delegation source. A resource provider must explicitly authorize its resource-owning signer and confirm the grant is free for the exact request. The application must not use the user's owner-wallet key as a substitute for provider-side stake authorization.

## Release gate

Until such a provider agreement and documented adapter exist, automatic free Energy-plus-Bandwidth acquisition is not complete. Existing owner resources can still satisfy a deployment preflight naturally, including free Bandwidth where the exact transaction fits the available quota. The zero-TRX gate remains mandatory and owner-controlled TronLink approval remains separate.
