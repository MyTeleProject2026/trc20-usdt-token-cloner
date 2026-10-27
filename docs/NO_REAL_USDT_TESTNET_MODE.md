# No-real-USDT testnet workflow

## What this mode is for

Use the Nile or Shasta TRON testnet to exercise the app without real USDT. Testnet TRX and test tokens have no monetary value; they are not Mainnet Tether and exchanges must not be told that they are real deposits. This workflow is a development/test environment, not a way to create spendable exchange balances.

The sign-in screen links to the faucet for the selected testnet and to TRON's official guide for test tokens:
- Official guide: https://developers.tron.network/docs/getting-testnet-tokens-on-tron
- Nile faucet: https://nileex.io/join/getJoinPage
- Shasta faucet: https://shasta.tronex.io/join/getJoinPage

## Steps

1. Open the testnet workspace at `#/` and select Nile or Shasta.
2. In a separate tab, use the faucet link for that exact network to request testnet assets for a dedicated test wallet.
3. Set TronLink to the same testnet and use the test wallet for sign-in.
4. In the testnet workspace, choose the TRC-20 test-token option and enter the actual token contract address deployed on that testnet. Do not paste a Mainnet token address and assume it represents the same asset.
5. Read the on-chain balance and perform only testnet operations. Check the transaction on the matching testnet explorer.

Never enter a private key or recovery phrase into this app. Use only wallet-controlled signing prompts for testnet actions.

## Real Mainnet limitations

The separate Mainnet exchange-deposit page sends only from the connected Mainnet wallet and uses the fixed official TRON USDT contract. A genuine transfer needs the sender or an authorized sponsor to own the tokens being transferred, plus adequate network fees or an actual fee-sponsorship arrangement. A fee-sponsorship provider can cover gas, but cannot manufacture the transferred USDT. If a wallet has no real USDT, a real USDT transfer cannot be sent from that wallet.

No UI-only balance, generated receipt, custom token, or testnet transaction constitutes a Mainnet USDT deposit. Exchange credit can only be confirmed from that exchange's own account records. The OKX deposit-history page is read-only and shows only records returned by the configured OKX API.

## Scope of the current implementation

The testnet workspace is for exercising the existing testnet flows. It does not claim that sponsored transfers are enabled. Sponsorship endpoints remain fail-closed until provider integration, signer authorization, sponsor funding, consent/limits, and fee settlement are end-to-end verified. No real transfer is submitted by this documentation or by the OKX history feature.
