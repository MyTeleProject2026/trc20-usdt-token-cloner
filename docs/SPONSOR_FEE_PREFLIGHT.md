# Sponsor Fee Preflight

## Purpose

The sponsor fee preflight endpoints read current TRON node state to help operators inspect the likely network-resource shortfall for a proposed transfer. They are diagnostic endpoints only. They do not sign transactions, reserve a sponsor budget, delegate resources, broadcast a transaction, or authorize a sponsored send.

## Native TRX transfer

`POST /api/tron/sponsorship/native-fee-estimate`

Accepted JSON fields:

- `network`: `mainnet`, `shasta`, or `nile`
- `receiverAddress`: TRON Base58 destination
- `amountBaseUnits`: positive integer string in SUN

The backend asks the fixed node for an unsigned `TransferContract` draft and validates that its sender, receiver and amount match the request. It estimates the signed protobuf size using the raw-data bytes, protobuf envelope bytes and one 65-byte signature allowance. It then compares the estimate against the principal sponsor's current staked/free bandwidth and the node's current `getTransactionFee` parameter.

This remains an estimate: the final signed transaction can differ, resources can change, and the response is not an exact fee guarantee. A normal transaction charges resource use to the transaction owner unless a valid resource delegation or another supported sponsorship mechanism has actually been completed and verified.

## TRC-20 transfer

`POST /api/tron/sponsorship/fee-estimate`

Accepted JSON fields:

- `network`: `mainnet`, `shasta`, or `nile`
- `tokenContract`: exact token contract
- `receiverAddress`: TRON Base58 destination
- `amountBaseUnits`: positive uint256 integer string

Official Tether USDT is recognized only on TRON Mainnet at `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` with six decimals. No configurable token allowlist can redefine Tether's contract identity. Nile/Shasta token contracts and independent project tokens are not eligible as Tether payout principal. Testnet diagnostics cover native TRX fee/resources only.

The endpoint simulates the exact direct `transfer(address,uint256)` call from the principal sponsor, reads current energy pricing, and reports the principal sponsor's estimated Energy shortfall separately from the fee sponsor's own resources. It deliberately does not claim to estimate signed transaction bandwidth or total network fee.

## Required server configuration

For every network enabled for preflight, two distinct accounts must be configured:

- `SPONSOR_ASSET_<NETWORK>_ADDRESS`
- `SPONSOR_FEE_<NETWORK>_ADDRESS`

These are public addresses, not signing credentials. A configured address does not prove that the owner agreed to sponsor the flow, that the account holds a spendable budget, or that the account has delegated the required Energy/Bandwidth.

Do not put seed phrases or private keys in the repository, browser bundle, request payload, or chat. Signing authority must remain in an approved wallet/provider boundary with explicit sponsor consent and per-transfer authorization.

## Why submission remains disabled

Both preflight endpoints always return `canSubmitSponsoredTransfer: false`, `submissionEnabled: false`, and `transactionBroadcast: false`. They do not enable the GasFree submit route.

Before a real sponsored transfer can be activated, the project still needs a tested authorized signer/broadcast adapter, real sponsor consent, distinct and funded principal/fee budgets, verified resource delegation (if the fee sponsor is intended to supply resources to another account), per-transfer caps, replay/idempotency protections, emergency stop, solidified receipt verification, reconciliation, and testnet end-to-end/security review.

For exchanges, on-chain settlement alone does not confirm that the exchange credited an account. The receiving exchange must separately support the exact asset and network and confirm any deposit tag/memo and credit requirements.
