# Sponsor provider capability audit

**Checked:** 2026-10-23  
**Scope:** public TRON fee sponsorship and sponsor-funded receiver assets for this application. This is a capability audit, not a provider endorsement.

## Decision

No suitable public, unrestricted, no-cost Mainnet sponsor was verified that both (a) pays fees for this application's existing TRON account transfers and (b) supplies spendable TRX or official USDT principal for arbitrary recipients. The application must remain fail-closed until an actual sponsor is identified, explicitly agrees to the program, and has verifiable funded assets/resources.

This finding means **no qualifying provider was verified in this research**; it is not a claim that no private grants or negotiated sponsorships exist.

## Sources reviewed

1. **TRON: Bandwidth and Energy** — https://developers.tron.network/docs/bandwidth-and-energy  
   TRON transactions consume Bandwidth; smart-contract execution consumes Energy. Bandwidth and Energy can come from a sender's stake or resources delegated by another account. If resources are insufficient, the chain can burn TRX. Delegation is a resource mechanism backed by staked resources, not a grant of spendable USDT or TRX principal.

2. **TRON: Delegating resources** — https://developers.tron.network/docs/delegation  
   Stake 2.0 supports delegating Bandwidth/Energy to another account. The delegator needs available staked resources and must sign/submit the delegation. It is a technically valid route to sponsor resources only if the sponsoring account and budget are real, authorized, and funded.

3. **TRON: Getting testnet tokens** — https://developers.tron.network/docs/getting-testnet-tokens-on-tron  
   Public Shasta and Nile faucets provide test TRX and test TRC-20 tokens for development. They are not Mainnet funding sources and cannot fund production receiver balances.

4. **Tatum Wallet SDK: signing transactions and messages** — https://docs.tatum.io/oa/docs/wallet-sdk-sign-transactions  
   The current documentation marks `sponsorGas` as **EVM only**. The presence of TRON wallet support in the broader SDK does not establish that this parameter sponsors TRON transactions or arbitrary existing TronLink/EOA transfers. Do not implement this as TRON sponsorship without provider documentation and an end-to-end supported flow.

5. **Tatum: Smart Wallets SDK** — https://docs.tatum.io/docs/wallet-sdk  
   Tatum describes an MPC wallet lifecycle in which its wallet infrastructure participates in signing. This is architecturally different from sponsoring transactions initiated by an existing external wallet. It does not provide the sender's or receiver's asset principal for free.

## Required capability separation

### Network-fee / resource sponsorship
- Must be backed by a verified sponsor account, resource pool or supported relayer.
- Must be supported for the exact network and transaction type, not inferred from a generic “gasless” claim.
- Must have explicit sponsor consent, per-network and per-transaction limits, an emergency pause, and immutable reservation/settlement reconciliation.
- A regular TRON EOA transfer cannot be treated as sponsored merely because a provider API key is reachable. For TRC-20 calls, contract/resource rules and the exact signing flow must be verified. Mainnet USDT's contract cannot be reconfigured by this app.

### Sponsor-funded asset principal
- Requires the sponsor to own actual on-chain TRX or token balances and authorize an actual outbound transfer.
- Must be budgeted separately from transaction fees. Database/UI credits are not funds.
- Must not be funded with receiver deposits or silently fall back to user funds.
- Official Mainnet USDT must be the reviewed Tether contract on Mainnet; an independent project token such as VTRC must never be labelled official USDT.

### Recipient and exchange behavior
- A valid on-chain transfer normally does not require the receiver to sign or accept the transaction.
- It does **not** guarantee that every exchange or wallet lists the asset, displays its metadata, supports that network, or credits an exchange deposit. Exchange credit is controlled by that exchange's deposit policy, confirmations, and any required memo/tag.
- Spending controls cannot be imposed after sending to an ordinary external wallet. Any lock/vesting behavior requires an audited contract or controls at the receiving platform.

## Activation gate

Do not enable sponsored submission until all of the following are evidenced and reviewed:

1. A named sponsor/provider confirms the exact TRON Mainnet or testnet capability and terms.
2. The sponsor authorizes the application and a funded account/resource budget is independently verified.
3. Signing is delegated through a supported authorization scheme; no user private key is collected or stored by the backend.
4. Per-user and per-recipient limits, token/network allowlists, idempotent requests, atomic budget reservations, replay protection, settlement reconciliation, and audit history are tested.
5. Shasta end-to-end tests verify actual receiver balances and solidified receipts for each transfer type.
6. An operator separately approves any Mainnet activation after security review.

Until then, `server/sponsorship-status.mjs` must remain disabled and the UI must show only verified on-chain balances and verified transaction history. No provider secrets, Render variables, production database, or chain state were changed by this audit.
