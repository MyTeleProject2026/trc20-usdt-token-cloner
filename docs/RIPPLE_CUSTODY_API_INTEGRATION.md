# Ripple Custody Wallet API connector

## What is integrated

The server-side adapter in `server/ripple-custody-client.mjs` follows Ripple Custody (Wallet)'s published API:
- OAuth credentials endpoint: `POST /v2/credentials/oauth/token`.
- Native TRX balance: `GET /v2/vaults/{vaultId}/wallets/{walletId}/balances`.
- TRON native TRX fee estimate: `POST /v2/transactions/transfer/estimate-fee`.
- Native TRX payment submission method: `POST /v2/vaults/{vaultId}/wallets/{walletId}/transactions/transfer`.
- Transaction status: `GET /v2/vaults/{vaultId}/wallets/{walletId}/transactions/{transactionId}`.

Official docs:
- https://docs.ripple.com/products/wallet/get-started/use-the-api
- https://docs.ripple.com/products/wallet/transactions/send-assets
- https://docs.ripple.com/products/wallet/transactions/view-and-track-transactions
- https://docs.ripple.com/products/wallet/vaults-and-wallets/wallets/understanding-balances
- https://docs.ripple.com/products/wallet/governance-and-controls/policies

The provider uses separate API credentials for Wallets and Transactions. Production tokens last 60 seconds; Sandbox tokens last one hour. Client secrets are shown only once. Keep them in a server-side secret manager, not in VITE frontend variables or Git.

## Required server configuration

- `RIPPLE_CUSTODY_ENV=sandbox` (switch to production only after Ripple provisions the organization).
- `RIPPLE_WALLETS_CLIENT_ID` and `RIPPLE_WALLETS_CLIENT_SECRET`.
- `RIPPLE_TRANSACTIONS_CLIENT_ID` and `RIPPLE_TRANSACTIONS_CLIENT_SECRET`.
- `RIPPLE_VAULT_ID` and `RIPPLE_WALLET_ID`.
- `RIPPLE_TRON_SOURCE_ADDRESS`.
- `RESTRICTED_TRX_BENEFICIARY_ADDRESS` set to the confirmed Bitpie multisignature address.

The Ripple organisation must already have a provisioned TRON wallet. New Ripple wallets start with zero balance and are deposit-only. Before sending, the account needs a funded TRX balance, active outgoing setting, applicable active transaction LIMIT policy, and the recipient registered in the address book/allowed by policy. This adapter does not create or bypass organization roles, policies, approvals, or compliance controls.

## Funding / credit limitation

Ripple's API reports wallet balances, not an unsecured loan facility. The adapter reports available/total/frozen/pending TRX independently and explicitly reports `creditFacilityVerified=false`. Public Ripple documentation requires a funded wallet to send. No public Ripple TRX principal-credit limit, drawdown terms, or credit-funded fee allocation has been verified for this project. The connector therefore does not treat a Ripple wallet balance or Gas Station as borrowed TRX.

The `createNativeTrxTransfer` method has an additional hard authorization callback which defaults to false. No route in this repository currently passes a funding authorization, so no live transfer can be submitted. Even with valid credentials, the connector can only read balances and estimate fees until an approved facility/allocation is independently evidenced and production execution is reviewed.

## Bitpie restricted destination

Bitpie's 2025 update says new TRX multisig accounts created after 14 December 2025 are free and that TRON multisig transfers support Energy Rental. This supersedes the 2024 tutorial's old 100 TRX setup-fee instruction for new addresses. Energy Rental reduces eligible resource costs; it does not provide the transfer principal or a general native-TRX gas credit. The current Bitpie app must show native TRX in the multisig asset list and receive page before the exact multisig address is accepted.

References:
- https://bitpie.zendesk.com/hc/en-001/articles/14623739284495--Update-Multi-Sig-Adds-Energy-Center-Support-Lower-Costs-Update-to-v5-0-208
- https://developers.tron.network/docs/bandwidth-and-energy
- https://docs.gasfree.io/ (GasFree only supports gas-free TRC20 transfers; it does not support native TRX transactions)

## Status

This is a real API adapter, but it is not connected until the account owner completes Ripple organization onboarding and creates the two credentials. No credit facility, funded fee account, provider authorization, Bitpie multisig address, or live transfer is assumed.
