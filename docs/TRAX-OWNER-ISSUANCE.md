# TRӾ owner-issued Mainnet economics

## Selected policy

- Issuance: owner-authorized, with no fixed supply cap other than Solidity's uint256 range.
- Backing: none. Minting does not require a native TRX deposit.
- Redemption: none. The token contract has no TRX vault and no redemption function.
- Price: no guaranteed peg or exchange execution price. The dashboard may display a TRX-linked reference valuation for TRӾ, but this is not a redemption promise, reserve claim, oracle-enforced market price, or proof of a trade.
- Authorization: the current on-chain owner can enable issuance, mint, pause, and transfer ownership. The next owner must accept ownership.
- Transfers: standard TRC-20-style transfers, approvals, and delegated transfers; account-level locks have been removed so external wallets can use the token normally.

## Independent external-wallet credit

The owner calls `credit(recipient, amount, referenceId)`. This mints directly to the supplied TRON address, emits the standard `Transfer(address(0), recipient, amount)` event, and emits `OwnerCredit` with a nonzero referenceId. `batchCredit` supports up to 50 recipients per transaction. Issuance does not require a native TRX deposit or reserve.

The contract rejects zero or previously used reference identifiers, preventing a credit reference from being replayed for a second issuance. Batch credits use the same uniqueness check for every row.

A successful on-chain transfer or mint only proves that the token contract credited a blockchain address. It does not prove an exchange has credited an internal customer account. The exchange must explicitly support this exact TRON Mainnet contract address, token, and network, and independently process its deposit.

## TRX-linked reference valuation

The frontend obtains a timestamped TRX/USD and USDT/USD quote from CoinGecko's simple-price API. It uses the TRX/USD quote as the TRӾ reference valuation rate, so the displayed TRӾ reference value moves when the quoted native TRX price moves. Quotes older than five minutes, malformed quotes, and provider errors are rejected; the UI must not label a missing or stale quote as live.

Portfolio value is calculated as:

`native TRX quantity × TRX/USD quote + TRӾ quantity × TRX/USD reference quote + USDT quantity × USDT/USD quote`

The dashboard must show each underlying quantity separately and label the total as an estimated portfolio valuation. This calculation does not make TRӾ trade at the reference price. Independent exchanges and wallets can show different prices or no market at all. A quoted TRX-linked value is not guaranteed cash value and is not evidence of liquidity, backing, redemption, or exchange listing.

## Operational warnings

Unlimited owner minting can dilute existing holders and may cause the market value to fall sharply. The owner can mint without collateral, so holders must not be told that TRӾ is fully backed, redeemable 1:1 for TRX, or guaranteed to track TRX. Do not advertise TRӾ as native TRX or imply exchange listing/credit without written exchange support.

The dashboard requires the configured owner wallet and TRON Mainnet. Deployment, issuance, pause changes, and transfers each require a user-initiated TronLink approval. Price retrieval and portfolio valuation are read-only; they do not sign or broadcast blockchain transactions.
