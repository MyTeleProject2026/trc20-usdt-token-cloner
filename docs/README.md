# TRON Token Studio documentation

This index identifies the current source of truth and separates the selected architecture, initial self-custody code integration, and remaining production acceptance work.

## Read these first

1. [Platform-owned treasury architecture](PLATFORM_OWNED_TREASURY_ARCHITECTURE.md) — separate identity wallet + platform-owned treasury + wallet-provider signing. No sponsor organization or Fireblocks vault is mandatory.
2. [Current implementation status](CURRENT_IMPLEMENTATION_STATUS.md) — source components now present on the implementation branch, explicit blockers, and remaining acceptance work.
3. [Self-custody treasury runbook](PLATFORM_TREASURY_SELF_CUSTODY_RUNBOOK.md) — backend configuration, funding prerequisites, frontend workflow, API contracts, and release checklist.
4. [Current managed-withdrawal route reference](TREASURY_WITHDRAWALS.md) — legacy Fireblocks-backed route and its hard-disabled execution status.
5. [Wallet authentication implementation](WALLET_AUTH_IMPLEMENTATION.md) — existing signature challenge/session protocol. Login is not transaction authorization.

## Retained supporting documents

### Wallet, destination, and chain verification
- [Wallet authentication](WALLET_AUTHENTICATION.md)
- [Exchange and wallet destination integration](EXCHANGE_AND_WALLET_DESTINATION_INTEGRATION.md)
- [Real transfer and network boundaries](REAL_TRANSFER_AND_NETWORK_BOUNDARIES.md)
- [Transfer verification API](TRANSFER_VERIFICATION_API.md)
- [Network-scoped verification records](NETWORK-SCOPED-VERIFICATION-RECORDS.md)

### Optional managed custody / provider path
- [Fireblocks organization and vault setup](FIREBLOCKS_ORGANIZATION_VAULT_SETUP.md)
- [Fireblocks inventory workflow](FIREBLOCKS_INVENTORY_WORKFLOW.md)
- [Tatum KMS integration audit](TATUM_KMS_INTEGRATION_AUDIT.md)
- [Provider integration assessment](PROVIDER-INTEGRATION-ASSESSMENT.md)

These documents describe optional or existing provider-specific work. They do not make Fireblocks, Tatum, or any provider a source of free USDT principal.

### Optional external sponsorship
- [External sponsor operating contract](EXTERNAL_SPONSOR_OPERATING_CONTRACT.md)
- [Third-party treasury authorization](THIRD_PARTY_TREASURY_AUTHORIZATION.md)
- [Sponsor provider selection](SPONSOR_PROVIDER_SELECTION.md)
- [Sponsor go-live gates](SPONSOR_GO_LIVE_GATES.md)
- [Sponsor request intake](SPONSOR_REQUEST_INTAKE.md)
- [Sponsor reconciliation acceptance](SPONSOR-RECONCILIATION-ACCEPTANCE.md)

External sponsorship is not part of the selected default architecture. Keep its consent, mandate, funding, and approval requirements if the product later reintroduces it.

### Operations, deployment, and testnet
- [Production environment setup](PRODUCTION_ENVIRONMENT_SETUP.md)
- [Render sponsor configuration](RENDER_SPONSOR_CONFIGURATION.md)
- [GasFree provider integration](GASFREE-PROVIDER-INTEGRATION.md)
- [No-real-USDT testnet guide](NO_REAL_USDT_TESTNET_GUIDE.md)
- [Testnet sandbox guide](TESTNET_SANDBOX_GUIDE.md)
- [Stage A/B/C testing guide](STAGE_A_B_C_TESTING_GUIDE.md)

## Superseded files removed

The overlapping owner-treasury and generic funded-withdrawal guides were consolidated into the architecture, status, route-reference, and runbook documents. Their unique security and operational points were retained. Existing source, migrations, tests, provider adapters, and sponsor evidence were not deleted.

## Document maintenance rule

Update the architecture, status, and runbook whenever the signer model, withdrawal lifecycle, feature gates, or funding source changes. Documentation never enables a payout or substitutes for automated tests, independent review, or a real acceptance transaction.
