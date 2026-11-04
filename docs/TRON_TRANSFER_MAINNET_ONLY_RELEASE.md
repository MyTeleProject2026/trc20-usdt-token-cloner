# Tron Transfer — Mainnet-only production release

Tron Transfer supports only official Tether USDT on TRON Mainnet. Nile, Shasta, custom token contracts, testnet balances, simulated credits, sandbox payouts and direct wallet-funded sends are disabled.

Official TRON Mainnet USDT contract: `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`.

Default read-only monitored address: `TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp`. It is never treated as a payout funding source.

## Provider responsibilities

- Tatum: server-side Mainnet RPC, recipient TRX/USDT reads, incoming-history support, and solidified transaction/receipt verification.
- Fincra: authorized live USDT TRC20 crypto-wallet payout submission and status.
- Authorized sponsor/business: supplies the USDT principal and required network resources through its approved Fincra source.
- Tron Transfer: requester identity, payout request intake, owner authorization, idempotency, provider reconciliation, webhook processing and chain evidence.

## Live controls

Live Fincra submission remains closed until all requirements are verified:
- Fincra live API credential and business ID.
- Fincra live stablecoin payout permission for the business.
- Fincra USDT source wallet with available funds at least equal to the requested principal.
- Fincra webhook secret and configured webhook endpoint.
- Tatum Mainnet API key and reachable solidified Mainnet node.
- Database available for durable payout state and reconciliation.

Secrets must remain server-side. Never embed Fincra/Tatum credentials or private keys in the static frontend or repository. Provider permissions and sponsor funding must be granted by the authorized organization; source code cannot create either.

## Withdrawal status

1. Request recorded: no payout submitted.
2. Fincra submission: owner-authorized, live-only and exact-balance preflight.
3. Fincra accepted/processing: not settled.
4. Fincra successful: provider reports payout completion; still not independent chain proof.
5. On-chain verified: exact official USDT Transfer event and successful solidified Tatum transaction/receipt match the request's network, contract, recipient, sender and amount.
6. Exchange internal credit: not asserted without authorized exchange-side deposit evidence.

## Replay and reconciliation

- Each request has a unique customer reference.
- Before a payout POST, the backend queries that exact reference.
- If the call outcome is ambiguous, reconciliation happens first. A 404 for a previously attempted request does not trigger another POST; manual Fincra reconciliation is required.
- Amounts are compared in six-decimal integer base units.
- Fincra submission and successful timestamps are persisted. Chain history candidates must match the exact amount, official token and destination within the payout time window.
- Webhooks are authenticated against the raw request body with HMAC-SHA512.

## Release criteria

A successful build proves only application startup. Live payout acceptance requires authorized credentials, live enablement, source USDT and network resources. Production acceptance requires a controlled, authorized live payout with successful Fincra status and independent Mainnet transaction verification. API acceptance alone never marks a withdrawal complete.
