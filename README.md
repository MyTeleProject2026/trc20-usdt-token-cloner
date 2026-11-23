# TRON Transfer Owner Admin

TRON Transfer is the existing TRON Mainnet Owner Admin application. It includes the AETHERIA Home, TRӾ contract administration, and two independent local wallet workspaces: Owner and Sponsor. The Sponsor Wallet is part of the same application; it is not a separate portal or a wallet-creation service.

> **Release status — 24 November 2026:** architecture corrections and the local Sponsor signing protocol are implemented on [draft PR #263](https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/pull/263). The latest verified frontend workflows passed (155 tests, zero failures, frontend build successful). The PR is not merged or verified as deployed to production. Production database acceptance and Mainnet release gates remain closed.

## Wallet architecture

### Owner Wallet
- Import an existing TRON Mainnet private key, V3 Keystore JSON, or mnemonic.
- Encrypt the local vault in the browser with AES-256-GCM and PBKDF2-SHA256.
- Unlock only for the Owner's local transaction-signing session.
- Keep application password/session authentication separate from wallet key custody.
- Sign Owner operations locally; no injected TronLink connection is required.

### Sponsor Wallet
- Import an existing Sponsor private key, V3 Keystore JSON, or mnemonic. There is no Create Wallet action.
- Keep its encrypted vault, unlock/lock/logout/reconnect/replace lifecycle independent from the Owner Wallet.
- Require a distinct Sponsor address and a separate Sponsor application session.
- Sign the exact prepared resource transaction locally. The Sponsor private key is not sent to the Resource API, and the legacy server-side Sponsor private-key fallback is disabled.

## Sponsor transaction lifecycle

1. The Resource API validates the Sponsor intent, Mainnet policy, current balance and resource state, then builds an exact unsigned transaction.
2. The API reserves the idempotency key and persists the unsigned transaction before returning it to the browser.
3. The imported Sponsor vault verifies the transaction belongs to that Sponsor address and signs it locally after explicit operator confirmation.
4. The API verifies unchanged transaction bytes, protobuf integrity, recovered signer and TRON permission; it repeats current balance, fee, Bandwidth and operation-specific state checks.
5. The API persists the exact signed payload and transaction ID before a single broadcast attempt, then reconciles the original transaction against solidified Mainnet state.
6. Unsigned reservations can be cancelled; expired reservations are marked failed. Signed or ambiguous operations are reconciled, never silently re-signed or replaced.

The client does not broadcast raw transactions. The Resource API does not receive private keys, mnemonic phrases, Keystore passwords or vault passwords.

## Mainnet safety and release gates

- Mainnet only; no testnet execution path is part of this application workflow.
- Sponsor ledger writes remain paused until production schema, database identity, backup/restore and durability acceptance are verified.
- Sponsor Mainnet execution flags remain disabled until the operator explicitly approves release after independent security review.
- The current production Sponsor operations table/bootstrap has not been accepted or activated.
- No Mainnet Sponsor transaction was signed or broadcast as part of this implementation work.
- Energy/Bandwidth rental, automatic free grants and independent fee sponsorship are not claimed or assumed. No provider is configured as a guaranteed resource source.
- Importing a Sponsor Wallet does not make TRӾ deployment ready; the Owner deployment page must pass its own fresh resource and zero-TRX-burn preflight.

## TRӾ contract

The existing `contracts/Restricted1TRAX.sol` source is preserved byte-for-byte. The token remains an owner-issued TRC-20 on TRON Mainnet, with six decimals and display symbol TRӾ. It is not native TRX, collateral, a redemption promise, or a guaranteed-price asset.

## Useful project documentation

- [Integrated Sponsor Wallet architecture](docs/INTEGRATED_SPONSOR_WALLET.md)
- [Sponsor go-live gates](docs/SPONSOR_GO_LIVE_GATES.md)
- [Draft implementation PR #263](https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/pull/263)

## Separate legacy sponsor-direct payout service

The repository retains a separate sponsor-direct USDT payout backend for existing treasury/settlement integrations. It is **not** the integrated Sponsor resource wallet, and its former standalone TronLink UI has been removed from the Owner Admin application. The historical [individual sponsor brief](docs/SPONSOR_BRIEF.md) (status date 12 November 2026) describes that separate workflow and should not be used as instructions for the active local Sponsor vault.

- [Read the individual sponsor brief](docs/SPONSOR_BRIEF.md).
- Open a [public, non-sensitive individual sponsor inquiry](https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/issues/new?template=individual-sponsor-inquiry.yml). Do not post wallet addresses, personal documents, private keys or seed phrases.
- [Legacy sponsor operating rules](docs/EXTERNAL_SPONSOR_OPERATING_CONTRACT.md).
- [Legacy sponsor/provider integration notes](docs/INDIVIDUAL_SPONSOR_AND_PROVIDER_FUNDING_INTEGRATION.md).

The historical brief documents a $5,000–$10,000 equivalent target in sponsor-controlled official TRON Mainnet USDT capacity. That is not a current funding claim, platform deposit, owner-controlled treasury balance, or promise of payout liquidity. The current integrated Sponsor Wallet is for TRX/resource management and Sponsor-to-Owner resource top-ups as documented above.

A separate legacy sponsor-direct payout backend remains distinct from the integrated Sponsor resource wallet. It is not exposed as a page in the Owner Admin navigation and is not used for Sponsor staking, delegation, or TRӾ deployment.
