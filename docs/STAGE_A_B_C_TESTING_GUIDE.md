# Hands-on guide: TRON network checks and official Tether boundaries

## Supported payout asset

TRON Token Studio's payout-request workflow is for **official Tether USDT (TRC-20) on TRON Mainnet only**:

- Contract: `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`
- Decimals: `6`
- Network: `mainnet`

Nile and Shasta do not carry official Tether Mainnet USDT. Do not deploy, import, or select an independent token and call it USDT. This product does not use VTRC or testnet token lookalikes for payout principal.

## Stage A — test network connectivity and TRX fee resources

Use a dedicated test-only wallet. In TronLink, select Nile or Shasta and verify the selected network before connecting.

1. Obtain testnet TRX only from the official faucet linked by the TRON developer documentation.
2. Use the wallet to inspect its testnet TRX balance and available resources.
3. Use the app's read-only testnet balance/resource checks to confirm the selected network and wallet address.
4. Do not use testnet tokens as payout principal, do not submit a testnet USDT request, and do not expect a testnet balance to appear on Mainnet or an exchange.

Official TRON developer references:
- https://developers.tron.network/docs/getting-testnet-tokens-on-tron
- https://developers.tron.network/docs/bandwidth-and-energy

## Stage B — read-only balance and receipt checks

The app's public-chain balance and transaction-verification endpoints are read-only. They do not sign or broadcast transactions.

For native TRX:
```http
GET /api/tron/native-balance?network=shasta&address=<TRON_ADDRESS>
```

For a transaction receipt, use the relevant network-specific read-only verifier and compare the exact sender, recipient, transaction type, result and block data. Do not infer a payment from a database row, a pending sponsor request, a wallet screenshot, or a provider's transaction-creation response.

A read-only balance snapshot is not a transfer receipt and is not an exchange deposit record.

## Stage C — official Mainnet Tether payout readiness

Before any genuine Mainnet USDT payout can be considered, the actual treasury-owning organization must complete Fireblocks onboarding, custody approval, vault creation, transaction policy configuration, and genuine vault funding. The production request workflow is currently review-only and transfer execution remains hard-disabled.

The Mainnet Tether contract must be verified using Tether's official supported-protocol information:
https://tether.to/en/supported-protocols/

Official TRON USDT contract:
`TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`

Do not use a testnet token, a custom TRC-20 contract, or a displayed UI balance as a substitute for this official contract.

## Exchange deposit verification

Before an authorized organization eventually sends USDT to an exchange:
1. The recipient must obtain the deposit address from the exchange's own logged-in deposit page.
2. Confirm the exchange accepts Tether USDT on TRON/TRC-20, the minimum deposit, required confirmations, and any memo/tag requirements.
3. Verify the exact Mainnet transaction and solidified USDT Transfer event.
4. Wait for the exchange's own deposit record to show the correct asset and credited status.

A solidified chain transfer does not itself prove exchange credit. Never send a second transfer to conceal an unresolved first transfer.

## Safe status labels

- `request-stored`: the authenticated request exists in the application database.
- `pending-organization-review`: the organization's reviewer has not approved or reserved it.
- `submitted`: only when an actual transaction has been broadcast by an authorized workflow and the provider/node response is recorded.
- `verified-on-chain`: the solidified receipt and exact official Tether Transfer event match.
- `exchange-credited`: only when an authenticated record from the receiving exchange confirms credit.

The current production payout workflow does not reach `submitted`; the backend execution gate remains disabled.
