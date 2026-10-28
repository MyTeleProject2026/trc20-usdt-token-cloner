# Owner treasury funding and genuine USDT payouts

## Security model

TRON Token Studio is a standalone, locally signed owner wallet. The backend can verify the configured owner's signed identity message and read public chain state, but it must never receive a wallet private key. The Mainnet treasury panel is read-only; the normal Wallet Vault transfer review is the only transfer-signing path in this app.

The app cannot mint genuine Tether USDT. The official TRON USDT contract is fixed at `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`. Deploying another Solidity token—even one with a matching symbol or a mint function—creates a different asset and does not make it official USDT or an accepted exchange deposit.

Every Mainnet send in the Wallet Vault is also gated by a fresh (five-minute) owner treasury verification at both transfer review and broadcast. The locally unlocked sender must exactly match the configured treasury address. This protects the owner-only application flow and prevents a stale UI snapshot from being reused; the actual transfer still depends on live on-chain balances and local transaction signing.

## Environment configuration

Configure these in the backend service environment, never in frontend variables:

- `TREASURY_OWNER_ADDRESS`: the public Mainnet address whose signed wallet login is allowed to read the owner treasury panel.
- `TREASURY_MAINNET_ADDRESS`: optional public address to read for treasury funds. If omitted, the backend uses `SPONSOR_MAINNET_ADDRESS`, then `TREASURY_OWNER_ADDRESS`.
- `TATUM_API_KEY`: API credential used for the independent solidified Mainnet balance reads.
- `DATABASE_URL`: persistent database used by the signed wallet authentication session store.

Do not place private keys, mnemonic phrases, API secrets, or exchange credentials in any `VITE_*` variable, GitHub commit, issue, APK asset, or frontend source.

## Real payout workflow

1. Unlock the exact local wallet whose address is configured as the treasury funding address. The owner must also sign in with the address configured as `TREASURY_OWNER_ADDRESS`.
2. Use **Sign owner check & read treasury**. The backend verifies the signed owner session and reads actual chain balances from the configured Mainnet address.
3. Confirm the reported treasury address and official USDT balance. The API fails closed if the funding address is invalid, the node read is unavailable, or returned evidence identifies a different address or network.
4. Select **Use funded treasury for a real USDT payout** only when the treasury address matches the locally unlocked wallet and a verified, non-zero official USDT balance is observed.
5. Enter the recipient and amount in the regular Send flow, review the exact token contract, address, amount, and estimated fee, and locally sign only after the app rechecks the live balance. The signing wallet must have sufficient genuine USDT and adequate TRX/resources for transaction costs unless a separately approved, funded fee-sponsor integration is actually enabled.
6. Check the transaction ID and successful solidified receipt. The receiving wallet or exchange makes its own deposit decision; an on-chain transfer does not guarantee credit.

## Important limitations

- There is no valid transfer path when no wallet or authorized treasury holds the required genuine USDT.
- Fee sponsorship can help pay network costs; it does not provide the USDT principal.
- The current GasFree endpoints are discovery and preflight only. Provider submission/signing is disabled until there is verified provider approval, a funded sponsor agreement, a reviewed signer integration, and end-to-end tests.
- Never display an app-generated number as a real on-chain balance or claim an exchange accepted a deposit without verifiable records from that exchange.
- Test on Nile/Shasta before any Mainnet use. This code has not been independently security-audited.
