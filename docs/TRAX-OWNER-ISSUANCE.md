# TRӾ owner-issued Mainnet economics

## Selected policy

- Issuance: owner-authorized, with no fixed supply cap other than Solidity's uint256 range.
- Backing: none. Minting does not require a native TRX deposit.
- Redemption: none. The token contract has no TRX vault and no redemption function.
- Price: no peg or guaranteed market value. TRӾ is not native TRX and is not the official TRON asset.
- Authorization: the current on-chain owner can enable issuance, mint, pause, and transfer ownership. The next owner must accept ownership.
- Transfers: standard TRC-20-style transfers, approvals, and delegated transfers; account-level locks have been removed so external wallets can use the token normally.

## External wallet credit

The owner calls `credit(recipient, amount, reference)`. This mints directly to the supplied TRON address, emits the standard `Transfer(address(0), recipient, amount)` event, and emits `OwnerCredit` with a nonzero reference. `batchCredit` supports up to 50 recipients per transaction to limit execution cost and prevent oversized batches.

A successful on-chain transfer or mint only proves that the token contract credited a blockchain address. It does not prove an exchange has credited an internal customer account. The exchange must explicitly support this exact TRON Mainnet contract address, token, and network, and independently process its deposit.

## Operational warnings

Unlimited owner minting can dilute existing holders and may cause the market value to fall sharply. The owner can mint without collateral, so holders must not be told that TRӾ is fully backed, redeemable 1:1 for TRX, or guaranteed to track TRX. Do not advertise TRӾ as native TRX or imply exchange listing/credit without written exchange support.

The dashboard requires the configured owner wallet and TRON Mainnet. Deployment, issuance, pause changes, and transfers each require a user-initiated TronLink approval. This change does not deploy a contract, sign a transaction, or broadcast a transaction.
