# Hands-on guide: Stage A, B, and C

This guide is for learning with your own wallets and assets. Never share a seed phrase/private key, and never send real funds to a testnet.

## Stage A — make a real Shasta test transaction

1. Open the official TRON developer instructions: https://developers.tron.network/docs/getting-testnet-tokens-on-tron. Use the linked Shasta faucet from that page.
2. Create two separate test wallets (sender A and receiver B). Use a dedicated test-only wallet. Do not import a Mainnet seed phrase into a test wallet.
3. In TronLink, select Shasta testnet. Check the network in the wallet itself before connecting to the app. The app's selected network and TronLink network must match.
4. Get Shasta test TRX for fees. To test your own VTRC contract, deploy it only on Shasta, then send a small amount from A to B. The token must already exist on Shasta and A must own enough of it.
5. Approve the transaction in TronLink. Copy the transaction ID only after the wallet reports submission.
6. Open the Shasta explorer linked from official TRON docs: https://shasta.tronscan.org. Search the transaction ID. Confirm network, token contract, sender, receiver, amount, and execution result.
7. In the app, choose the same Shasta network and query the receiver balance for the exact VTRC contract and B address.

Expected: a transaction exists on Shasta and the receiver's balance for that Shasta contract reflects the transfer after solidified state updates. It has no Mainnet value.

## Stage B — verify and refresh the receiver balance

### Read-only balance endpoint

After the backend deploy containing this endpoint is live, call:

```http
GET /api/tron/token-balance?network=shasta&contract=<TOKEN_CONTRACT_T_ADDRESS>&address=<RECEIVER_T_ADDRESS>
```

Use `network=mainnet`, `shasta`, or `nile`; use the token contract and receiver address for that exact network. The endpoint queries `walletsolidity/triggerconstantcontract` and returns `balanceBaseUnits` as an integer string and the token's on-chain `decimals`. Convert for display with decimal-safe arithmetic; do not parse the base-unit string as a JavaScript Number. This endpoint is read-only and does not submit transactions or mark an exchange deposit as credited.


### Native TRX transfer verification

Native TRX transfers are not TRC-20 token transfers. The backend also exposes a read-only native transfer verifier:

```http
GET /api/tron/verify-native-transfer/<64_HEX_TX_ID>?network=shasta
```

You may optionally supply all three expected values to require a match:

```http
GET /api/tron/verify-native-transfer/<64_HEX_TX_ID>?network=shasta&from=<SENDER_T_ADDRESS>&to=<RECEIVER_T_ADDRESS>&amountSun=<INTEGER_SUN>
```

Use the exact Base58 sender and receiver addresses and the amount in sun (1 TRX = 1,000,000 sun). If expected values are omitted, the response still reports the actual sender, receiver, and amount; compare them with your intended transfer before accepting it. A `verified: true` result requires the transaction body and receipt from the selected network's solidified node, a native `TransferContract`, and successful execution. A 202 response means wait and retry the same transaction ID. This endpoint does not sign, broadcast, or resend anything, and does not verify VTRC or exchange credit.

### Transaction verification endpoint

```http
GET /api/tron/verify-transfer/<64_HEX_TX_ID>?contract=<CONTRACT_HEX>&from=<SENDER_HEX>&to=<RECEIVER_HEX>&amountSun=<INTEGER_BASE_UNITS>
```

The server requires the token contract to be included in `TRON_VERIFIED_TOKEN_CONTRACTS`. Address query values must be 20-byte hex addresses, optionally prefixed by `41`; do not use a random contract or trust a wallet screenshot. `amountSun` is a generic smallest-unit integer despite the legacy parameter name: for VTRC at 18 decimals, 1 token is `1000000000000000000`; for official TRON USDT at 6 decimals, 1 USDT is `1000000`.

Retry a 202 response later; it means solidified transaction body/receipt is not available yet. A 200 response with `verified: false` is not a successful transfer. A successful verification proves the matching event on that network, not that an exchange credited the deposit.

### How to interpret the response

- `submitted`: the wallet returned a transaction ID; not final.
- `awaiting-solidification` / `awaiting-solidified-receipt`: retry after a short wait.
- `verified-on-chain`: the solidified transaction and Transfer event matched the expected values.
- `not-verified`: do not mark successful; inspect the reason.
- Balance endpoint `solidified-balance-read`: a balance was read for that network and contract; it is not an exchange receipt.

## Stage C — carefully test real Mainnet transfer

Do this only after Stage A and B pass and only with a small amount you can afford to lose.

1. Confirm the recipient address and network from the receiver directly. If the receiver is an exchange, open its official deposit page while logged in and confirm TRON/TRC-20 is supported for that exact asset, minimum deposit, required confirmations, deposit status, and any memo/tag instructions.
2. For official USDT on TRON Mainnet, verify the contract from Tether's official supported-protocol page: https://tether.to/en/supported-protocols/. The commonly published TRON USDT contract is `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`. Never use the VTRC contract as USDT.
3. Make sure TronLink is on Mainnet, the sender's wallet actually holds the selected asset, and enough TRX/resources are available for fees. Read the final wallet confirmation carefully.
4. Send a small amount to an address you control first. Check the transaction on the Mainnet explorer, verify the solidified receipt, and refresh the receiver's Mainnet balance for the exact contract.
5. Only send to an exchange when its official deposit page says the exact asset/network is supported. After the chain transaction confirms, wait for the exchange's own deposit history to show credit. The app cannot guarantee that credit and must not display `exchange-credited` without evidence from the exchange itself.

Do not send Shasta tokens to a Mainnet address expecting conversion. The same-looking address can exist on both networks, but their ledgers are separate.

## Sponsor fees

The current app reports sponsorship as `not-integrated`. Keep it disabled. First complete unsponsored Shasta tests. Then evaluate legitimate TRON Energy/Bandwidth delegation using the official docs: https://developers.tron.network/docs/bandwidth-and-energy. A sponsor covers eligible resources only; it does not provide token principal, convert testnet assets, or bypass exchange deposit checks.

## Troubleshooting

- Faucet says already claimed: wait for the faucet's cooldown or follow the official docs for another supported test method.
- Transaction not found on explorer: confirm you selected Shasta, copied the correct tx ID, and waited for propagation.
- Verification says contract not allowlisted: configure the reviewed test contract in `TRON_VERIFIED_TOKEN_CONTRACTS` in Render backend environment variables; never add arbitrary contracts just to make a check pass.
- Balance endpoint fails: check that the API deployment containing `/api/tron/token-balance` is live and that the contract supports TRC-20 `balanceOf(address)` and `decimals()`.
- Exchange has not credited: check the exchange's deposit page and official support. Do not send a second transfer until the first transaction/deposit status is understood.
