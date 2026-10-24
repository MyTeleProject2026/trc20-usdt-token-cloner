# Receiver sponsor-funded balance and access policy

## Product decision

The receiver may view sponsor-funded balances, while the sponsor defines whether the credited amount is usable or restricted. The receiver UI must distinguish an actual on-chain receipt from a sponsor-reported amount, a pending request, and a policy restriction.

This policy does not itself move funds, create a balance, or authorize spending. Sponsored submission remains disabled until the funding, signing, authorization, provider, and end-to-end verification gates in [SPONSOR_GO_LIVE_GATES.md](./SPONSOR_GO_LIVE_GATES.md) are satisfied.

## Required balance categories

- **Confirmed on-chain balance:** read from solidified state for the exact network, receiver address, and token contract. It is the wallet's real chain balance, not a platform-created credit.
- **Confirmed sponsor receipt — usable:** only after independently verifying the successful transfer event/receipt and refreshing the receiver's chain balance; the sponsor policy may allow this amount to be spent.
- **Confirmed sponsor receipt — restricted:** the chain transfer is real, but a restriction applies only if the asset remains under a control mechanism that can enforce it (for example, a sponsor-controlled platform ledger/custody arrangement or an audited smart contract). A normal TRC-20 transfer to an external wallet cannot make tokens non-spendable through a UI setting.
- **Pending:** sponsor intent or submission exists, but solidified chain evidence is missing. Do not include it in confirmed balance.
- **Display-only / not transferred:** a sponsor's reported budget, published balance, or proposed grant. Show it separately and label it **not received / not spendable**. Never add it to the receiver's on-chain balance.
- **Failed / expired / reversed by provider:** not spendable; reconcile reservations and show the actual final status.

## Sponsor policy fields

A future approved sponsor grant should carry an immutable policy snapshot tied to the grant/transfer ID:

- sponsor identity/reference and verified sponsor source address;
- exact network, asset type, token contract (for TRC-20), decimals, and amount in base units;
- receiver address and transfer/request ID;
- access mode: `usable`, `restricted`, or `display-only`;
- restriction reason and policy version; optional start/end time and spend/use limits;
- separate principal and network-fee funding roles and budgets;
- sponsor authorization evidence, expiry, nonce/idempotency key, and audit reference;
- transaction hash, solidified receipt/event evidence, confirmation time, and last chain-balance refresh time.

Unknown, stale, contradictory, or unverified policy/funding state must fail closed. The sponsor's published amount is not proof of spendable on-chain funds or authority to spend.

## Receiver UI requirements

1. Show confirmed chain balance separately from sponsor budget, pending grant, and restricted/display-only amounts.
2. For every amount, show network, token contract, decimals, raw base units, source, last verified time, and status.
3. Show **usable** only when both (a) the transfer or custody/contract credit is independently verified and (b) the applicable sponsor policy enforcement is active.
4. If funds were sent to a normal external wallet, show the on-chain balance as the wallet's balance and do not claim the app can restrict its spendability.
5. Do not label a request as received/confirmed until exact network, receiver, token contract, amount, successful receipt/event, and solidification are verified.
6. Principal and network fees must each be covered by their authorized sponsor. Never fall back to the sender's funds.
7. Never request or store a sender or sponsor seed phrase/private key in the frontend or general API runtime.

## Acceptance tests before enabling transfers

- Display-only sponsor budget never increases confirmed receiver balance.
- Pending/failed transfers never appear as received funds.
- Confirmed balance refresh matches exact chain, receiver, and token contract.
- A usable label requires confirmed transfer evidence and an active, enforceable policy.
- A restricted label is rejected for ordinary external-wallet transfers unless an actual custody/contract control enforces it.
- Sponsor principal and fee funding are independently authorized, funded, reserved, and reconciled.
- Duplicate, expired, replayed, underfunded, wrong-network, wrong-contract, and failed transfers cannot credit the receiver.
- No sender-funded fallback; no Mainnet enablement without independent security review and operator approval.
