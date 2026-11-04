# Owner-authorized Fincra payouts

The owner-only Mainnet withdrawal target is Fincra USDT TRC20. The owner authenticates with the existing wallet session and signs a fresh, short-lived authorization message for every payout. The signed message binds the owner, application origin, network, official USDT contract, recipient, beneficiary name, amount and unique customer reference.

Fincra business credentials are server-only. The browser must never receive the API key or webhook secret. The payout API persists the customer reference before contacting Fincra, and an unknown provider request outcome must be reconciled using that same reference. A timeout must never trigger a new payout with a replacement reference.

A Fincra API acceptance/processing response is pending, not paid. A provider success status is still awaiting chain proof. Tatum must verify the exact transaction body, solidified receipt and official USDT Transfer event before the app says chain-confirmed.

## Go-live gates

- Fincra merchant KYB is approved and live USDT TRC20 payouts are explicitly enabled.
- The merchant's Fincra payout account has sufficient USDT principal or a formally approved credit facility.
- Fincra production credentials, business ID, webhook secret and allowed callback setup are installed only in backend secrets.
- The business daily and per-payout limits are confirmed and configured.
- Tatum Mainnet access works and verifies a small controlled payout's exact recipient and amount.
- Webhook signature, idempotency, duplicate handling, timeout recovery, reconciliation, emergency pause and exchange-specific deposit requirements are reviewed.
- CI and security checks pass before any controlled Mainnet release.

The current feature branch keeps live-value execution disabled. No real payout is claimed or attempted by the source changes.
