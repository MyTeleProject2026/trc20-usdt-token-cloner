# TronLink owner-controlled Mainnet deployment setup

This repository uses the connected owner's TronLink signer. It does not require, accept, or store a private key, seed phrase, wallet password, or server-side signing secret.

## Owner account and network

- Network: TRON Mainnet (TronGrid host: `https://api.trongrid.io`).
- Configured TRӾ owner address: `TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp`.
- The connected application account and TronLink's active signing account must match this owner address.
- The owner permission threshold must be satisfiable by the connected signer alone. If the account uses multiple required owner keys, this single-wallet flow stops before requesting a signature.

## One-time wallet setup

1. Install or open the official TronLink wallet from its trusted distribution channel.
2. Unlock the wallet locally and select the configured owner account.
3. Switch the wallet network to TRON Mainnet.
4. Open the deployed Tron Transfer application in the same browser profile (or the wallet's DApp browser on mobile).
5. Choose **Connect wallet** and approve the account-connection request in TronLink. This connection authorizes the app to read the selected public address; it does not sign a transaction.
6. Confirm that the application shows the configured owner address and TRON Mainnet. If the app reports a different account or network, stop and correct the wallet selection before proceeding.

Do not paste wallet recovery words, private keys, passwords, or exported keystore files into the application, ChatGPT, GitHub, Render, or support messages.

## Deployment flow

1. Open the TRӾ Mainnet **Deploy** section.
2. Confirm that the saved contract address is empty. A saved address blocks a second deployment by default.
3. Set the maximum transaction fee limit. This is a network fee ceiling, not a charge or prepaid balance.
4. Run **Check deployment readiness** to perform a read-only preflight, or choose **Preflight & deploy TRӾ** to run the checks immediately before the wallet prompt.
5. The app checks the compiled `Restricted1TRAX` artifact, owner permission threshold, exact deployment Energy estimate, transaction Bandwidth, current account resources, and zero-TRX fallback budget. If any estimate is unavailable or any resource shortfall would require TRX, deployment is blocked before signing.
6. Review the CreateSmartContract transaction in TronLink. Confirm the network, owner account, and deployment action before approving. Reject the request if any detail is unexpected.
7. After approval, the application validates the signature against the unchanged transaction payload, rechecks resources and owner permissions, and broadcasts only if the zero-TRX-burn checks still pass.
8. The application waits for a solidified Mainnet receipt and verifies the transaction, deployed runtime bytecode, owner, and TRӾ / TRӾ / 6-decimal metadata. Preserve the transaction ID if confirmation is delayed; use the recovery flow rather than submitting a duplicate deployment.

The TEnergy promotional Energy claim, if the owner is eligible, is a separate provider-controlled step and may request its own wallet message signature. It is not a contract deployment transaction, does not grant Bandwidth, and is never treated as a guaranteed resource grant.

## TRONSCAN source verification

After a confirmed deployment, generate the exact compiler input bundle:

```sh
npm run verification:bundle --prefix Frontend-Tron-Transfer
```

Use the confirmed contract address and the generated Standard JSON input described in [TRONSCAN-VERIFICATION.md](../Frontend-Tron-Transfer/TRONSCAN-VERIFICATION.md). The current bundle generator prepares verification data; it does not submit to TRONSCAN or claim verification is complete. Record the actual TRONSCAN verification result and URL only after the explorer confirms it.

## Operational and security boundaries

- Wallet connection is not transaction authorization. Each deployment requires a fresh owner approval in TronLink.
- Never automate around wallet prompts, owner permission thresholds, or signature rejection.
- Never place a private key or seed phrase in frontend environment variables, Render secrets, GitHub Actions secrets, or source code.
- A server-side resource observer may read public chain state, but it cannot sign as the owner or create provider grants without the provider's explicit authorization mechanism.
- Mainnet deployment is irreversible. Verify the source release, contract settings, owner account, and transaction details before approving.
- A TRONSCAN contract page or deployed bytecode check is not the same as TRONSCAN source-code verification.
