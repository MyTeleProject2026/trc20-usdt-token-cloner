# Exchange and crypto-wallet destination integration

## Scope and truthful status

This document defines the destination contract for sponsor-funded transfers. It is not a claim that universal exchange support or sponsored broadcasting is enabled.

- **Self-custody wallet:** an on-chain transfer can be confirmed for the exact network, token contract, destination address, and amount. The destination wallet's actual balance can be read from solidified chain state.
- **Exchange deposit address:** the blockchain can confirm a transfer to the deposit address, but only the exchange can confirm that the account deposit was credited. The exchange may require a supported asset/network pair, minimum deposit, memo/tag, confirmation threshold, account eligibility, or other checks.
- **Contract / smart-account destination:** support must be tested for that contract and network. A syntactically valid address is not proof that the destination can receive or credit the asset.
- **Unsupported or unverified destination:** must be blocked before sponsor authorization. Do not infer support from a token symbol, address format, or successful provider lookup.

## Current integration boundary

The API already exposes read-only sponsor role snapshots at `GET /api/tron/sponsorship/roles?network=<mainnet|shasta|nile>`. The backend reads solidified TRX and allowlisted TRC-20 balances through Tatum and reads network-fee sponsor resource snapshots. This is a live chain-state read when the endpoint reports `onChainBalanceRead: true`; it is not proof of sponsor consent, available program budget, signing authority, or permission to send.

The GasFree integration exposes provider capabilities, account metadata, preflight, and trace lookup for Mainnet and Nile. `POST /api/gasfree/submit` deliberately returns HTTP 503. GasFree preflight alone does not implement a sponsor-funded principal transfer and does not authorize a transaction. Shasta is not a documented GasFree network in this integration.

No server-side private key or seed phrase may be added to this repository or pasted into chat. A production sender must be an explicitly authorized sponsor signer/provider, with spend limits, destination allowlists, replay protection, idempotency, audit trails, and an emergency pause. Keep submission disabled until these are implemented and independently reviewed.

## Required destination registry

Each destination integration should be a versioned server-side record, not a UI guess. Minimum fields:

- destination provider ID and type (`self-custody`, `exchange`, or `contract-wallet`);
- supported network IDs and exact asset/token contract addresses;
- whether a memo/tag is required and how it is encoded;
- minimum deposit/transfer and decimal precision where applicable;
- required chain finality / confirmations;
- exchange API integration status and the authoritative API status field used to verify account credit;
- last successful capability check, provider API version, and integration owner;
- allowlist/review status and explicit disable reason.

Do not store exchange account passwords, API secrets, or wallet private keys in destination records. Exchange API credentials, when genuinely required and authorized, belong in the secret manager and must be scoped to the minimum read-only deposit-status permissions. Never request withdrawal permissions merely to check a deposit.

## Transfer state machine

1. `destination-unchecked`: collect the exact destination address and selected asset/network.
2. `destination-compatible`: validate the exact network, token contract, address encoding, any required memo/tag, minimum amount, and destination allowlist. For exchanges, this means the destination details were supplied by the account owner from that exchange's current deposit screen; it does not mean account credit is guaranteed.
3. `sponsor-preflight-passed`: independently read the principal sponsor's token/TRX balance, fee sponsor's TRX/resources, active budget, fee policy, authorization, and per-transfer limits. All checks must be current and consistent.
4. `authorized`: record verifiable sponsor signature/provider authorization, nonce, expiry, destination, asset, exact base-unit amount, and maximum fee. A text reference alone is insufficient.
5. `submitted`: only after the approved adapter reports a transaction ID and the signed transaction was actually broadcast. An unknown timeout is `submission-unknown`, not failure; query the same transaction/trace before any replacement.
6. `solidified-on-chain`: verify the exact network, transaction body, successful smart-contract receipt, allowlisted token contract, Transfer event, sender, receiver, amount, and event index using solidified chain state.
7. `receiver-balance-refreshed`: reread the receiver's solidified token balance and reconcile it with the transfer evidence.
8. `exchange-credited`: only when the exchange's authenticated deposit-status API or another authoritative exchange record confirms credit. Without that connection, display `solidified-on-chain; exchange credit not verified`.
9. `failed / expired / reconciliation-required`: release reservations only after safely resolving the original transaction state and writing an audit record.

Never treat a provider capability response, broadcast response, transaction hash, indexer row, sponsor budget, or UI balance as proof of final receipt.

## Supported scope must be explicit

A network/asset/destination pair is supported only when its integration record is enabled and its tests pass. The first practical rollout should be a small testnet pilot with an explicitly configured sponsor wallet, one allowlisted token contract, one external wallet, and one verified exchange deposit flow if that exchange offers a suitable API. Expand one integration at a time. There is no generic API that can guarantee every exchange will accept every token or network.

## Release acceptance tests

- Sponsor principal and fee balances are read from the correct solidified network and exact configured addresses; unavailable reads fail closed.
- Separate fee and principal budgets are atomically reserved and cannot be double-spent under concurrent requests.
- The receiver gets the full requested amount; sponsor fees are separately covered and never silently deducted from the transfer principal.
- Sender wallet funds are never used as a fallback.
- Wrong network, wrong token contract, wrong receiver, missing required memo/tag, unsupported asset/network pair, expired authorization, reused nonce, and over-budget requests are rejected before signing.
- Duplicate submits and ambiguous provider timeouts do not create duplicate transfers.
- A submitted transfer is not shown as received until solidified transfer evidence and the receiver balance refresh agree.
- Exchange credit is shown only when the exchange itself confirms it; otherwise the UI explicitly reports only on-chain settlement.
- Failure, timeout, cancellation, and reconciliation drift produce durable audit records and safe reservation release.
- Testnet end-to-end, dependency audit, and security review pass before any Mainnet submission can be enabled.

## Official technical references

- TRON transaction lifecycle and solidification: https://developers.tron.network/docs/tron-protocol-transaction
- TRON sign/broadcast and solidified receipt verification: https://developers.tron.network/docs/api-signature-and-broadcast-flow
- TRON confirmation semantics: https://developers.tron.network/docs/confirmation-semantics
- Exchange-specific deposit network, address, memo/tag, and credit rules must be taken from the actual receiving exchange's current deposit UI/API. Examples: https://support.kraken.com/articles/360000672643-how-to-deposit-cryptocurrencies-to-your-kraken-account and https://www.okx.com/en-us/help/how-do-i-find-my-deposit-address-and-tag-memo-comment
