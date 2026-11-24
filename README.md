# TRON Transfer Owner Admin

TRON Transfer is the existing TRON Mainnet Owner Admin application. It contains the AETHERIA Home monitor, the existing TRӾ contract administration workspace, and two independent local wallet workspaces: Owner and Sponsor. This repository does not define a second application or a separate Sponsor portal.

## Fixed architecture

- **Owner wallet:** independently imported into an encrypted local browser vault; signs only Owner contract deployment and Owner-authorized TRӾ operations.
- **Sponsor wallet:** independently imported into its own encrypted local browser vault; signs only its own TRX staking, unstaking, matured withdrawal, Energy/Bandwidth delegation or undelegation to Owner, and explicit TRX top-ups to Owner.
- **Tatum:** preferred TRON Mainnet read-only RPC provider when configured.
- **TronGrid:** read fallback and the explicit signed-transaction broadcast and transaction-history path.
- **Neon:** the existing PostgreSQL database for Owner/Sponsor sessions, operation ledgers, idempotency, audit history and recovery.
- **Render:** hosts the existing frontend and Resource API services. The Blueprint does not provision a replacement database.
- **TRӾ contract:** existing Solidity source and deployed contract behavior are preserved.

Tatum and TronGrid are blockchain connectivity services only. Neither signs transactions, holds wallet keys, provides Energy/Bandwidth, pays fees, supplies TRX, or acts as Sponsor.

## Wallet custody and transaction rules

- Owner and Sponsor private keys, mnemonics, keystore passwords and vault passwords remain in their respective browser-local vaults and are never sent to the Resource API or stored in Neon.
- Each wallet signs only transactions owned by that wallet.
- The Resource API prepares exact unsigned transactions, validates the returned signature and permission, persists signed payloads and transaction IDs before broadcast, broadcasts once through TronGrid, and reconciles the original transaction against solidified Mainnet state.
- Ambiguous submissions are reconciled by their original transaction ID. The API must not silently re-sign or replace an ambiguous operation.
- Owner and Sponsor application sessions are separate. Sponsor writes require the independent Sponsor and Owner Admin authorization checks.
- No TronLink injection is required for the primary Owner or Sponsor workflow.

## TRӾ contract

The existing `contracts/Restricted1TRAX.sol` source is preserved byte-for-byte. TRӾ is an owner-issued TRC-20 on TRON Mainnet with six decimals and display symbol TRӾ. It is not native TRX, collateral, a redemption promise, or a guaranteed-price asset.

## Intentionally excluded

The active platform has no testnet execution path, third-party Energy/Bandwidth supplier, GasFree relay, TEnergy promotion or claim, WDK wallet provider, Fincra payout, Fireblocks custody/inventory, external treasury, third-party Sponsor account, Sponsor Direct Payout, provider payout, exchange-credit workflow, or backend private-key signer. These are not hidden behind feature flags; obsolete modules, routes, tests, scripts and documentation are removed from the active repository.

## Production acceptance boundary

The implementation branch is not production release evidence. Before enabling production writes or deployment execution, complete independent security review, verify the existing Render service identities and actual Neon database fingerprint, confirm backup/restore readiness, apply the guarded Sponsor ledger bootstrap through authenticated Owner/CSRF authorization, enroll Owner and Sponsor separately, and complete desktop/mobile browser acceptance for local signing, persistence-before-broadcast, idempotency and solidified transaction recovery.

Sponsor funding/resource arrangements are treated as already prepared. The remaining release work is implementation verification and controlled acceptance—not sourcing another Sponsor, provider, Energy, Bandwidth or fee arrangement.

## Project documentation

- [Owner/Sponsor Mainnet architecture](docs/OWNER_SPONSOR_WALLET_ARCHITECTURE.md)
- [Integrated Sponsor Wallet implementation](docs/INTEGRATED_SPONSOR_WALLET.md)
- [Sponsor Mainnet go-live gates](docs/SPONSOR_GO_LIVE_GATES.md)
- [Render, Tatum, TronGrid and Neon configuration](docs/RENDER_SPONSOR_CONFIGURATION.md)
- [Production acceptance requirements](Frontend-Tron-Transfer/resource-api/PRODUCTION_ACCEPTANCE.md)
- [Current implementation PR #263](https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/pull/263)
