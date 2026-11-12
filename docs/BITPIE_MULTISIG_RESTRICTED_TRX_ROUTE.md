# Bitpie multisignature route for visible, non-single-signer TRX balances

## Why this route matters

The user's requested outcome is: native TRX is visible in Bitpie, but the Bitpie user cannot move it unilaterally. A normal transfer to an ordinary single-signature Bitpie address cannot impose this restriction. The address owner can normally spend the received TRX.

Bitpie's own help centre publishes a multisignature feature and lists TRX among the supported cryptocurrencies. Its guide describes inviting other Bitpie users by UID, choosing a signature threshold, creating a multisignature address, and paying a 100 TRX network fee (with at least 200 TRX recommended for fee reliability). It also explicitly warns against creating multisig accounts with strangers and recommends leaving recovery redundancy rather than 2-of-2 or 3-of-3.

Official article:
https://bitpie.zendesk.com/hc/en-001/articles/10142742328591-Bitpie-Multisignature-Usage-Tutorial

The article is not fully consistent: its opening list includes TRX, but a later supported-payment-currencies list omits native TRX and the worked setup section is titled for USDT-TRC20 multisig. Therefore, native TRX receive/display/withdraw behaviour must be confirmed in the actual current Bitpie app or with Bitpie support before using this as the production design. Do not assume the feature supports every native-TRX operation from the article's opening list alone.

## How multisig could meet the requested visible-but-not-single-key-spendable outcome

A Bitpie multisig wallet has a real TRON address. If Bitpie's current app supports displaying native TRX for that multisig address, a provider can send an ordinary native TRX transfer to that address. The TRX then appears as the multisig address's actual on-chain balance, while withdrawals require the configured threshold of signatures.

This is different from an escrow smart contract:
- the TRX is held at the Bitpie multisig address itself;
- the address balance can be queried through the solidified TRON API;
- transaction authorization is enforced by TRON account permissions (weights and thresholds);
- the address is generally a newly created multisig address and may not equal the user's existing ordinary Bitpie address.

The current Bitpie guide asks participants to invite other Bitpie users by UID. Do not add an unknown provider or stranger as a signer. Every signer must be a trusted party whose key recovery and availability have been independently considered.

## Threshold trade-offs

- A 1-of-2 configuration does not prevent a participant with one key from spending alone.
- A 2-of-2 configuration prevents unilateral spending but Bitpie warns that loss of either key can make funds unusable.
- A 2-of-3 configuration can provide one-key loss tolerance while preventing any one key from spending alone. However, any two signers can move funds, so the signer group and trust model matter.
- A 3-of-3 configuration requires every participant and is also discouraged in Bitpie's guide due to key-loss lockout.

No threshold is universally safe. Select the participants and threshold based on the real parties who should be allowed to release the assets. Do not use a provider as co-signer unless the provider explicitly accepts that role in writing.

TRON's official Account Permission Management documentation explains weighted keys, thresholds, owner and active permission slots, and the risk of irrecoverable permission updates:
https://developers.tron.network/docs/multi-signature

## Tron Transfer permission audit

This repository now includes a read-only account permission assessment:
- `server/tron-account-permission-assessment.mjs`
- attached to `getSolidifiedAccount()` as `permissionAssessment`
- displayed in `Frontend-Tron-Transfer/src/RestrictedTRXEscrow.jsx`

The audit checks:
- the owner permission threshold;
- each active permission and its operations bitmap;
- whether any single configured key alone can authorize direct TRX/TRC-10 transfers, staking/unfreezing and rewards (`FreezeBalance`, `UnfreezeBalance`, `WithdrawBalance`, Stake 2.0, and resource delegation types), contract creation/calls (`CreateSmartContract`, `TriggerSmartContract`), or permission changes (`AccountPermissionUpdateContract`).
- whether the permission key list has valid TRON addresses, distinct signer addresses, positive weights, reachable thresholds, and valid active permission IDs.

The audit is read-only. It does not change account permissions, create a multisig, or sign a transaction. It cannot know whether one human controls multiple keys; the signer identities and their recovery arrangements must be checked by the wallet participants. A permission audit that is unavailable or malformed is not considered restricted.

## Funding and provider accounting

A Bitpie multisig account still needs actual TRX:
- the multisig creation transaction has an on-chain fee described by Bitpie as 100 TRX; the article recommends at least 200 TRX be available to avoid failure from network fluctuations;
- a later 6,200 TRX deposit requires a real sender to own or have authorized credit for 6,200 TRX plus transaction fees;
- when a provider sends a normal TRX transfer from its own wallet, the provider's available TRX balance decreases by the principal plus fees;
- under a genuine credit facility, available credit decreases and the amount becomes a repayment obligation under the agreement. It is not free money.

A public TRON API can read balances and permissions; it cannot provide principal, create TRX, or pay fees.

## Existing address versus multisig address

The user's initially supplied address `TLBWTZHjjRMwbFgKgqmLwjp4ZKjxt5a2GT` must not be called restricted unless its actual solidified account permissions prove that no single key can authorize relevant value-moving and permission-control operations. If Bitpie's multisig flow creates a new address, use that new multisig address as the beneficiary instead; do not keep using the original address merely because it was supplied earlier.

Bitpie's in-app multisig creation process may create a new multisig address. If it does, set:
- frontend build variable `VITE_RESTRICTED_TRX_BENEFICIARY_ADDRESS` to the actual generated multisig address;
- server variable `RESTRICTED_TRX_BENEFICIARY_ADDRESS` to the same address before deploying the escrow contract or verifier.

Do not put private keys, seed phrases, Bitpie recovery phrases, or participant secrets into environment variables, GitHub, chat, or Tron Transfer.

## Provider credit remains a separate approval

A multisig address solves the recipient-side unilateral-spending restriction. It does **not** provide the TRX principal or network fees. The selected funding provider must still contractually approve:
- the exact customer and jurisdiction;
- a TRX-denominated credit facility or provider-owned payout allocation;
- the principal amount and fee budget;
- permitted destination address and purpose;
- automated transaction limits and signing/authorization method.

No current public Ripple document establishes the principal-credit facility requested by this project. Do not mark the provider-funded route ready until an authenticated facility response and executed agreement are verified.

## Production release criteria

1. Confirm the current Bitpie app supports native TRX in its multisig display/receive flow; resolve the documentation inconsistency first.
2. Create the multisig only among trusted participants and verify all signers understand recovery and threshold implications.
3. Confirm the generated multisig address in each participant's Bitpie app.
4. Query solidified TRON account state and run the permission assessment. Require multi-signature thresholds on every relevant active and owner permission.
5. Test that one signer alone cannot send a small test transaction on a test environment or with a non-production test account before funding meaningful assets.
6. Obtain provider credit/funding agreement and its API authorization.
7. Send only a small, approved production test deposit first; verify the incoming native TRX in Bitpie and the explorer.
8. Only then consider a larger provider-funded deposit. Do not promise that a 6,200 TRX balance is credited until the chain transaction is solidified and Bitpie itself displays the correct multisig address balance.

A multisig account can make actual TRX visible in Bitpie while preventing one key from spending it, **if the Bitpie app supports the native TRX flow and the permissions are configured and verified correctly**. It cannot create an unfunded or fictitious balance.
