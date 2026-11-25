# TRON Transfer Owner/Sponsor Mainnet architecture

This document describes the active architecture for the existing Tron Transfer Owner Admin application. It supersedes older provider-independent, testnet, external-sponsor and payout architecture notes.

## Two independent wallets

### Owner workspace
The configured Owner Mainnet wallet is the contract owner/admin identity. It imports into an encrypted local browser vault and signs only Owner-owned operations:
- deploy the existing TRӾ contract;
- issue/mint and administer TRӾ within the existing contract permissions;
- perform external and batch credits;
- pause/unpause and manage minting authorization;
- transfer contract ownership through the existing pending-owner process;
- perform Owner-authorized transfers and other supported contract operations.

### Sponsor workspace
The configured Sponsor Mainnet wallet is a separate wallet, distinct from Owner. It imports into its own encrypted local browser vault and signs only Sponsor-owned operations:
- stake and unstake its own TRX;
- withdraw matured unfreeze balances;
- delegate Energy and Bandwidth directly to the configured Owner address;
- undelegate its own resources from Owner;
- explicitly transfer its own TRX to Owner when required.

Sponsor does not become the TRӾ contract owner merely by providing resources. Delegated Energy/Bandwidth and TRX funding are separate operations; delegated resources do not themselves pay transaction fees.

## Mainnet connectivity

- **Tatum is the preferred read-only TRON Mainnet RPC provider** when `TATUM_API_KEY` is configured and `TATUM_TRON_NETWORK=mainnet`.
- **TronGrid is the read fallback** when Tatum is unavailable, rate-limited or returns an invalid response.
- **Signed transaction broadcast remains pinned to TronGrid.** Transaction-construction endpoints and write/broadcast requests are never sent to Tatum.
- Tatum credentials remain server-side. Neither provider receives wallet private keys or signs transactions.
- Neither provider supplies Energy, Bandwidth, TRX, liquidity, custody or fee sponsorship.

The same read-provider policy is used by the Resource API, Owner-operation API, deployment API and Sponsor transaction engine. Browser Owner contract reads use the Resource API read proxy; the proxy applies Tatum-first/TronGrid-fallback routing.

## Receiving deposits

Each wallet workspace displays only its own authenticated/unlocked wallet address as its receive address. The operator can copy the address or open it on TRONSCAN. The existing Resource API confirmed transaction feed is used to display incoming native TRX transfers and official USDT TRC20 transfers. This is a read-only receive flow: it does not generate a new address, create a deposit contract, custody funds, credit an internal balance, or submit a transaction. TRӾ is not included in the deposit feed because it is a custom token and must be separately identified by its verified contract.

## Persistent application data

The existing Neon PostgreSQL database stores:
- independent Owner and Sponsor account/session metadata;
- Owner operation and TRӾ deployment ledgers;
- Sponsor operation ledger and paused-write control;
- prepared and signed transaction records;
- idempotency keys, transaction IDs and operation states;
- resource delegation history, audit records and recovery metadata.

The existing Neon database is retained. The Render Blueprint must not create a new Render-managed PostgreSQL database.

## Render services

Keep the existing `tron-transfer` frontend Static Site and the existing `tron-transfer-resource-api` Web Service. The frontend contains both workspaces. The Resource API connects to Tatum, TronGrid and Neon using server-side configuration.

## Signing and broadcast boundary

1. The correct workspace requests an exact unsigned transaction.
2. The Resource API validates the requested operation, network, account, amount, resource state and authorization.
3. The matching local vault signs only after explicit operator confirmation.
4. The Resource API verifies the exact signed bytes, signer address and active TRON permission.
5. The signed payload and transaction ID are persisted before a single TronGrid broadcast attempt.
6. The original transaction ID is reconciled against solidified Mainnet state. Ambiguous submissions are never silently re-signed or replaced.

No private key, mnemonic, keystore password or vault password is sent to the backend. No backend signer, external custodian, remote signer, or injected TronLink provider is part of the active workflow.

## Release boundary

Production Sponsor writes and Owner deployment execution remain gated until the production database identity, schema, backup/restore, independent wallet enrollment, browser-local signing, failure recovery and security review are accepted. CI success alone is not production acceptance.

The existing TRӾ Solidity contract is unchanged. No testnet execution, external provider payout, GasFree, TEnergy claim, WDK, Fincra, Fireblocks, third-party treasury, external Sponsor or Sponsor Direct Payout flow belongs to this architecture.
