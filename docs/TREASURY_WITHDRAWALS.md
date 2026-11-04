# Fincra USDT TRC20 withdrawals

The default Mainnet payout integration is Fincra only. Fireblocks treasury, vault, custody and payout integrations are not supported in this project.

See [FINCRA_TATUM_PAYOUT_ARCHITECTURE.md](FINCRA_TATUM_PAYOUT_ARCHITECTURE.md) for the provider contract, exact owner authorization, server configuration and chain-verification rules.

## Current implementation status

The feature branch contains a server-side Fincra adapter and owner-only payout API. It is pinned to `destinationCurrency=USDT`, `paymentDestination=crypto_wallet` and `paymentScheme=usdt_trc20`. The owner must sign a message binding the exact recipient, account-holder name, amount, network and customer reference.

Live-value payout execution remains deliberately disabled in this build. Sandbox submission is separate from a real Mainnet transfer. A Fincra status of successful is not a chain confirmation. Tatum must independently verify a successful solidified Mainnet transaction against the official Tether contract, exact recipient and exact six-decimal amount.

Fincra must approve the business for live stablecoin payouts and the business account must be funded with the required payout principal, or have an explicit approved credit facility. The local owner wallet does not need to hold the payout principal, but application code cannot create the provider's funds. An exchange deposit credit is determined by the receiving exchange and is not guaranteed by a chain receipt.
