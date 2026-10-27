# Simple testnet send guide

The main workspace has two separate paths:

- **Sponsored transfer request:** unavailable until a real, authorized, funded sponsor integration is completed. The platform must not charge the sender as a fallback.
- **Direct testnet transfer with TronLink:** sends an actual transaction on the selected Nile or Shasta testnet. The connected sender wallet owns the asset and pays any network fee.

## Send a testnet transfer

1. Open the workspace and select **Nile testnet** or **Shasta testnet**. Select the same network inside TronLink. These networks are isolated; their assets are test assets with no Mainnet value.
2. In **Asset principal**, select native TRX or the TRC-20 option and enter the exact token contract address on that testnet. Contract name and symbol alone do not prove identity. A project-created token is not official Tether USDT.
3. In **Sender account**, select **Connect & sign in with TronLink**. Check the displayed account and network. Watch-only mode is read-only and cannot send.
4. In **Receiver & amount**, enter the receiver address on that same testnet and a positive amount. Select **Verify receiver on selected network** and review the exact contract/address and balance snapshot.
5. In **Send a real testnet transfer with TronLink**, review the displayed sender, receiver, network, asset, amount and token contract. Select **Sign and send testnet transfer** only when every value is correct. Review the TronLink transaction prompt before approving.
6. The app keeps the transaction ID and checks the solidified transaction/receipt against the exact requested sender, receiver, amount and token contract. If the transaction is pending or verification is unavailable, choose **Verify transaction** for the same ID. Do not send again while its result is uncertain. The app permits preparing another transfer only after the prior transfer is verified.
7. Open the displayed TronScan link and compare the transaction details. A confirmed testnet transfer proves only that testnet transaction; it does not prove a Mainnet transfer or an exchange deposit credit.

## Important limits

- Nile and Shasta transactions cannot credit an exchange's real Mainnet deposit balance. A receiving platform must explicitly support that testnet for test transactions; do not send testnet assets to a Mainnet deposit address expecting real funds.
- The direct-send path is wallet-funded, not sponsor-funded. The sender's wallet can pay the network fee. It is not a workaround for the disabled sponsor integration.
- The application never asks for a seed phrase or private key. Approve only the transaction that matches the details shown on screen.
- An exact on-chain balance, token symbol, or TronScan transaction does not guarantee that an external exchange has credited a deposit. An exchange's own deposit status is separate.
