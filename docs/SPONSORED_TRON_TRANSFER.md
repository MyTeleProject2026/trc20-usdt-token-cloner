# Sponsor-funded TRON transfer architecture

## Scope

This document describes a legitimate way for an application user to avoid personally paying the TRON network fee for an otherwise valid transfer. It does not create tokens, bypass the sender's authorization, or make a fictional balance real. A sponsor must actually provide network resources or pay costs.

## Preconditions

- The asset is a real token on the selected network, and its contract address is verified against the issuer's official documentation.
- The sender controls the source wallet and approves the transfer through their wallet or an explicitly supported authorization mechanism.
- The sponsor is an identified, consenting account with a budget, rate limits, and sufficient TRON resources or TRX.
- The receiver address is validated and shown to the sender before signing.
- The user sees the network, token contract, amount, recipient, and estimated cost before authorizing.
- The application never asks users to paste a seed phrase or private key into the website or backend.

## Recommended flow

1. The frontend obtains the sender address from a supported wallet provider; it never accepts a private key.
2. The backend creates a short-lived transfer intent containing network, token contract, sender, receiver, amount, expiry, and a unique nonce.
3. The backend validates token contract allowlists, transfer limits, compliance rules where applicable, and replay protection.
4. The sender reviews the intent and signs or approves it in their own wallet. A normal token transfer is signed by the holder; a transferFrom flow requires an allowance granted by the holder.
5. The sponsor checks the exact transaction, policy limits, available resources, and replay status. The sponsor may delegate Energy to the sender or sponsor a supported transaction flow. Sponsorship does not grant authority to move tokens.
6. The transaction is broadcast only after the required wallet authorization is verified.
7. The backend tracks the transaction by real TXID and verifies confirmation, sender, receiver, token contract, amount, and success status from trusted TRON data.
8. The UI shows Pending until confirmed, then Confirmed on TRON with a real explorer link. Failed, expired, rejected, and simulated states remain distinct.
9. The backend records an auditable sponsor ledger, transaction intent, sponsor cost, and final chain outcome. Do not store secrets or claim a transfer succeeded before confirmation.

## Fee reality

A user may pay zero directly if the sponsor funds the required resources or transaction costs. This is not cost-free to the system: the sponsor must have sufficient TRX/resources and may incur costs. If no sponsor funds resources, the application must not promise a free real transaction. The wallet should show any cost or resource shortfall before the user signs.

## Mandatory security gates before enabling mainnet

- Use a dedicated sponsor account with a capped balance and limited permissions.
- Do not put sponsor private keys in frontend code, browser storage, logs, or repository files.
- Prefer hardware-backed or managed signing with strict access controls, audit logs, and rotation.
- Enforce per-user, per-address, per-day, and global spending limits.
- Require idempotency keys, expiry, nonce/replay protection, and duplicate submission handling.
- Validate chain/network and token contract on the server; never trust a frontend-supplied token name or symbol.
- Verify actual on-chain results using the transaction receipt and contract address, not a user-submitted TXID alone.
- Add monitoring, alerting, emergency pause, and a sponsor-funding threshold.
- Test rejected signatures, insufficient token balances, missing allowance, resource shortage, failed receipts, replay attempts, and sponsor exhaustion on testnet.
- Keep mainnet payouts disabled until independent security review and sponsor funding approval are documented.

## Safe fallback

If any precondition fails, do not submit the transaction. Offer a clearly marked Simulation only action that writes only to a local demo ledger and never displays a fake TXID or labels the result as on-chain.
