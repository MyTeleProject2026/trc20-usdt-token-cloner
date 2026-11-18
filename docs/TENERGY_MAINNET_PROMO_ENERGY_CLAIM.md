# TEnergy Mainnet one-time Energy promo integration

## Purpose

The owner console now has a narrowly scoped integration for TEnergy's published one-time Mainnet promotional Energy grant. This is separate from paid Energy rental and generic sponsor onboarding.

Official provider documentation: https://tenergy.me/docs/api/promo

## Flow

1. `GET /api/tron/resource-promo/terms` reads public promo state, daily cap and grant terms.
2. `POST /api/tron/resource-promo/challenge` asks TEnergy to check the configured owner address for eligibility before any signature is requested.
3. The owner reviews and signs the exact returned TIP-191 message in TronLink using `signMessageV2`. This is a message signature, not a transaction or token approval.
4. `POST /api/tron/resource-promo/redeem` sends the address, single-use nonce and signature to TEnergy. The provider verifies the signature and initiates its own resource delegation.
5. `GET /api/tron/resource-promo/status?address=...` polls the provider redemption. When TEnergy reports `delegated`, the API also reads the owner's current resource counters from Tatum SolidityNode.

## Runtime configuration

- `OWNER_WALLET_ADDRESS` must be the exact owner-controlled Mainnet address. All claim/status routes reject another address.
- `TATUM_API_KEY` is required for the independent solidified owner resource snapshot.
- No TEnergy API secret is required for the public promotional endpoints.
- No wallet private key or seed phrase is accepted or stored by the backend.

## Limits and safety

- This is a one-time eligibility-gated Energy promo, not an unrestricted grant API.
- The promo can be inactive, capped, expired, already redeemed, or permanently ineligible for the owner address.
- A valid challenge is single-use and expires after ten minutes. Sign only the exact human-readable provider message.
- The provider response's `wallet_ticket` is deliberately stripped and never returned to the frontend.
- `granting` is not success. The UI must poll until the provider reports `delegated`.
- The Tatum resource snapshot is independent current state, not transaction-specific attribution and not a guarantee that deployment Energy is sufficient.
- The promo supplies Energy only. It does not supply Bandwidth, deployment principal, TRX, or a general-purpose provider-managed grant.
- The deployment gate remains closed until a fresh exact deployment simulation proves both Energy and Bandwidth coverage and zero TRX fallback.

## Owner UI

Open `#/resource-promo` while signed into the private owner console. The UI checks Mainnet, requests eligibility before opening a signature prompt, signs with TronLink, and displays the provider redemption plus the independent Tatum resource snapshot.

## API status meanings

- `promo-not-eligible`: TEnergy says this address was not included in the promotional drop (3038).
- `promo-already-redeemed`: this address already used its one claim (3039).
- `promo-not-available`: the promo is off, ended, not started, or capped today (3040).
- `granting`: provider accepted the claim but delegation is not yet complete.
- `delegated`: provider reports the resource delegation completed; verify the live resource snapshot separately.
- `solidifiedOwnerResources.verified`: Tatum successfully read current solidified resource counters. This field is not a claim that the promo supplied all available Energy.

No paid quote, order, rental, TRX transfer, or owner transaction is initiated by this integration.
