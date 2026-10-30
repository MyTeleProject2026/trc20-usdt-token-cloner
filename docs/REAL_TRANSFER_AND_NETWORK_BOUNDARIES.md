# Real transfers: supported networks, receiver balances, and sponsor limits

## What the application can do

- Connect to TronLink and request approval for each transfer.
- Read the balance returned by the selected TRON network and show token balances associated with their actual contract addresses.
- Send native TRX or call a TRC-20 contract when the sender's wallet is connected to that same network, the sender owns sufficient assets, and the wallet authorizes the transaction.
- Verify a transaction against solidified TRON transaction data and its receipt. The receiver should regard the funds as final only after the appropriate chain confirmation and wallet/exchange crediting rules.
- Store verification outcomes in the project's isolated PostgreSQL schema when the database is configured and ready.

## Genuine Mainnet exchange deposits

The separately routed `#/exchange-deposit` page supports user-authorized direct Mainnet transfers of native TRX and official Tether USDT over TRC-20. The USDT contract is fixed to `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`; the form does not accept custom token contracts for real deposits. It connects to TronLink, requires the active node to be the expected Mainnet endpoint, checks the current sender balance and USDT metadata, builds the exact sender/recipient/amount transaction, optionally adds transaction memo data, checks the built transaction before asking TronLink to sign, and broadcasts only the signed transaction. It then uses the existing solidified TRX/TRC-20 verification endpoints and may refresh the recipient's on-chain balance.

The page requires the sender to acknowledge that the destination and any memo were copied from the exchange's official deposit page and that the transfer is irreversible. Unresolved broadcast outcomes are retained in browser session state and block a second send until verification succeeds. A confirmed transaction is labelled **on-chain verified; exchange credit unverified**. The exchange field is a local note only: no exchange API is configured, no exchange ledger balance is fabricated, and only an exchange's own authoritative deposit status can confirm account credit.

User instructions: [Simple testnet send guide](SIMPLE_TESTNET_SEND_GUIDE.md). The Mainnet flow is separate from the Nile/Shasta workspace and does not make testnet assets valuable.

## Network boundaries that must not be bypassed

Shasta is a test network. Shasta TRX and tokens deployed on Shasta have no mainnet monetary value. Sending them to an address that also exists on mainnet does not move or credit mainnet funds. Mainnet and Shasta have independent ledgers and transaction histories.

The only supported payout principal is official Tether USDT on TRON Mainnet at `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` (six decimals). A genuine transfer requires an authorized and funded treasury, provider-side transaction approval, and sufficient TRX fee/resources. Native TRX is a separate fee/resource asset. Testnet tokens and independent TRC-20 contracts are not Tether and are not accepted by the payout-request API. The current application is review-only; the backend payout execution gate remains disabled.

An exchange may require a deposit address, network selection, minimum deposit, confirmations, and sometimes a memo/tag or other account-specific requirements. The application cannot force an exchange to credit deposits. Verify the exchange's official deposit page before sending; sending testnet assets to a mainnet deposit address does not create a credit.

## Sponsor-funded fees

The sponsor status endpoint intentionally reports sponsorship as not integrated. There is currently no verified provider adapter, funded sponsor account, sponsor authorization, or completed sponsored-transfer test. Do not claim sponsored transfers are working.

A real sponsor can pay or delegate the required TRON resources only when a legitimate supported flow is integrated, its funding and rules are confirmed, and the sender's authorization remains valid. Sponsoring fees cannot convert testnet assets into mainnet assets, mint official USDT, bypass receiver/exchange rules, or transfer tokens without the holder's authorization.

## Required production gates

1. Connect only through the user's wallet; never ask for a seed phrase or send private keys to the backend.
2. Display the selected network, sender, verified token contract, amount, receiver, and fee/resource information before wallet approval.
3. Reject cross-network assumptions; verify the sender's actual TronLink network.
4. Wait for the real transaction ID and verify transaction body, receipt result, event contract, sender, recipient, and raw amount.
5. Query the receiver's balance on the same network and exact token contract; distinguish pending, confirmed, and exchange-credited states.
6. Keep sponsorship disabled until a provider adapter, funded account/budget, authorization model, spending caps, replay protection, emergency stop, and testnet evidence pass review.
7. Keep mainnet operations explicitly user-approved and avoid claiming an exchange credit from a successful on-chain transfer alone.

## Live status

The code repository contains wallet-based transfer handlers and read-only chain verification. This documentation is not evidence that a particular transfer, sponsor, database connection, or exchange deposit has been verified in production. Check live wallet, chain, database, and provider responses before treating each capability as operational.
