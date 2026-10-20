# Receiver-side settlement and legitimate fee sponsorship

This document is the implementation contract for the next stage of TRC-20 Token Clone. It distinguishes a successful blockchain transfer from a wallet balance refresh and from an exchange deposit credit.

## Non-negotiable asset identity

- Shasta and Nile are isolated test networks. Their TRX and tokens are test assets and have no mainnet value.
- An independently deployed token such as VTRC is not USDT, even if it implements TRC-20 correctly or uses 18 decimals.
- Official TRON USDT is identified by the contract address published by Tether: `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`.
- Do not alter token metadata, transaction metadata, or the app UI to conceal the token contract from a receiver or exchange.

## Correct end-to-end lifecycle

1. **Prepare** — user selects a network, enters the recipient, selects the exact contract, and enters an amount. Convert amounts to integer base units using the token's verified decimals; never use floating-point arithmetic for token amounts.
2. **Preflight** — validate the network selected by TronLink, sender address, recipient address, exact token contract, available token balance, and available TRON resources/fee limit. Show all of these before wallet approval.
3. **Authorize and broadcast** — the user's wallet signs the transaction locally. The backend must never receive a seed phrase or private key. Treat a wallet return value as a submitted transaction, not proof of settlement.
4. **Verify** — fetch the transaction body and receipt from the selected network's solidified-node API. Check the transaction ID, successful execution result, emitting token contract, Transfer event signature, sender, recipient, and exact integer amount.
5. **Refresh receiver balance** — query the recipient's balance for the same network and exact contract after settlement. Display the balance as chain-reported data with network, contract, block height, and time. Do not credit a separate internal balance merely because a client supplied a transaction ID.
6. **Exchange status** — report only on-chain status from the chain. Exchange credit is a separate state that can only be confirmed from the exchange's own account/deposit history or an authorized official API. Do not label a deposit "credited" based solely on a successful transaction.
7. **Persist audit evidence** — store the network, transaction ID, contract, addresses, base-unit amount, verification result, block number, and timestamps. Enforce uniqueness on network + transaction ID + contract to make retries idempotent. Never store wallet secrets.

## Recommended explicit states

- `draft`: no transaction broadcast.
- `submitted`: wallet returned a transaction ID; not yet confirmed.
- `awaiting-solidification`: transaction body/receipt not available from solidified state.
- `failed-on-chain`: receipt says execution failed.
- `confirmed-on-chain`: verified Transfer event matches the expected transaction, contract, sender, receiver, and amount.
- `receiver-balance-refreshed`: receiver balance queried on the same network and contract after confirmation.
- `exchange-credit-pending`: optional informational state, only when a user is actually monitoring a supported exchange deposit.
- `exchange-credited`: only when verified from an authorized exchange source; never infer it from chain confirmation.
- `rejected-or-unrecognized`: an exchange reports that a deposit is unsupported or not credited. Provide official support/recovery instructions rather than attempting to hide token identity.

A transfer can be confirmed on-chain while exchange credit remains pending or rejected. These are not contradictory states.

## Legitimate fee sponsorship choices

1. **Simplest learning setup:** use Shasta and the official faucet to obtain test TRX and test tokens, then make sender-authorized transfers between two wallets on Shasta.
2. **Mainnet resource support:** a sponsor can stake TRX and delegate Energy/Bandwidth to the sender, or fund a clearly disclosed relayer flow where the protocol supports it. Delegation is a resource operation; it does not make the sponsor the token owner and does not create tokens.
3. **Contract-deployer energy sharing:** only applies to contracts your project deploys and controls, using the appropriate deployer resource-share configuration. It cannot make a third-party USDT contract charge its deployer for your users.
4. **Third-party token transfer sponsorship:** for a token contract you do not control, evaluate a documented, audited, TRON-compatible relayer/resource-delegation approach. It must preserve user consent, prevent replay, constrain allowed contracts/recipients/amounts, rate-limit spending, maintain sponsor reserves, and include an emergency stop. Do not enable a provider merely by setting an environment flag.

Sponsorship should remain disabled until there is a real provider/resource adapter, funded test account, explicit user consent, spending limits, replay protection, monitoring, and a passing Shasta integration test. Before mainnet, add a separate reviewed release gate and small-value transaction test with an address controlled by the project.

## Test matrix before enabling any production claim

| Test | Expected result |
|---|---|
| Shasta sender → Shasta receiver, known test token | Confirmed on Shasta; receiver balance refreshes on Shasta |
| Shasta transaction hash checked against Mainnet | Not found / not verified; never report a Mainnet receipt |
| VTRC contract passed as official USDT | Rejected by identity/contract allowlist |
| Wrong sender, recipient, contract, or base-unit amount supplied to verifier | Verification fails |
| Transaction included but execution failed | Failed-on-chain; no receiver credit |
| Duplicate verification request | Idempotent persistence; no duplicate credit |
| Database unavailable | Chain result remains honest; storage status reports unavailable |
| Sponsor not configured or out of budget | Sponsorship unavailable; no false success message |
| Mainnet transaction to an exchange | Confirm chain transfer first; exchange credit remains unconfirmed until the exchange confirms it |

## Operational security

- Keep `DATABASE_URL`, API keys, and sponsor credentials in Render environment variables only. Rotate any database credential that has been pasted into chat or logs.
- Do not use a free/temporary database for long-term financial audit data without backup and migration planning.
- Keep mainnet sending disabled in automated tests; never run tests that spend real funds.
- Do not promise an exchange will credit an asset. Confirm the exchange supports the exact network and token contract before a mainnet deposit.
- Do not automatically retry a broadcast with a new transaction unless the prior transaction's state has been checked. Repeated sends can create duplicate payments.

## Official references

- TRON resource costs and delegation: https://developers.tron.network/docs/bandwidth-and-energy
- TRON resource payment and Energy sharing: https://developers.tron.network/docs/paying-for-resources
- TRON TRC-20 contract interaction: https://developers.tron.network/docs/trc20-contract-interaction
- TRON testnet token guidance: https://developers.tron.network/docs/getting-testnet-tokens-on-tron
- Tether supported protocols and TRON USDT contract: https://tether.to/en/supported-protocols/
