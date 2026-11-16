# TEnergy Mainnet promotional Energy claim integration

This adapter connects the existing TRӾ Mainnet owner wallet to TEnergy's one-time promotional Energy grant. It does not enable paid rentals, does not create TRX, and does not supply Bandwidth.

## Flow

1. The backend checks the public promo state and the configured owner address's existing redemption record.
2. Before asking for a signature, it asks TEnergy for a claim challenge. TEnergy checks the wallet's original promo-drop eligibility first.
3. If eligible, the browser signs the exact TIP-191 message returned by TEnergy with the connected owner wallet. This is an off-chain message signature, not a TRON transaction and it does not consume Bandwidth or TRX.
4. The backend forwards only the owner address, one-time nonce and signature to TEnergy. It discards any wallet-ticket token returned by the provider.
5. The client waits for the provider to report a delegation, then independently re-reads the owner's Mainnet resource snapshot. The grant is counted only after the on-chain resource limit/availability increases.
6. The existing deployment preflight still estimates the exact CreateSmartContract transaction and independently requires zero TRX fallback. TEnergy's promotional claim covers Energy only; it does not cover the transaction's Bandwidth or guarantee that deployment is possible.

## Limits and fail-closed behavior

- Mainnet only; one grant per eligible address.
- The grant can be inactive, capped, expired, already redeemed, or unavailable to this owner.
- The promo token is not transferable eligibility: TEnergy checks whether the provider originally dropped it to the address.
- No private key, seed phrase, mnemonic, API secret, or wallet-ticket token is sent to or stored by this application.
- The backend rate-limits challenge and redemption requests.
- Provider status `granting` is not treated as a confirmed delegation.
- A provider response is not treated as chain evidence; only a fresh Mainnet resource read can establish resource availability.
- This does not provide Bandwidth, token principal, or free contract verification services.
- No server-side signing or contract broadcast is performed by this adapter.

Official API reference: https://tenergy.me/docs/api/promo
