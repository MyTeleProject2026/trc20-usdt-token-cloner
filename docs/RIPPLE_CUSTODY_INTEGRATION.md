# Ripple Custody (Vault) SDK service authentication

## Status

This branch now uses Ripple's official TypeScript SDK for the implemented provider read. It no longer accepts or forwards a manually supplied Ripple Bearer token. The SDK owns OAuth token acquisition, in-memory caching, renewal, TLS behavior, and response verification.

The implemented SDK call is client.governance.domains.list({ limit: 100, autoPaginate: true }). Other pre-existing provider read routes return a sanitized 501 until mapped to documented SDK methods. No raw REST or homemade token fallback is used.

## Authentication mode selected

This project is configured for the documented OAuth 2.0 client_credentials grant:

- RC_CLIENT_ID: Ripple-issued service client ID.
- RC_CLIENT_SECRET: Ripple-issued service client secret. Backend secret only; never store it in TOML, source control, browser variables, or logs.
- RC_CONFIG_FILE: optional path to the SDK TOML file. Defaults to config/ripple-custody.toml.

The SDK chooses client credentials only when both client ID and client secret are present. The status endpoint reports the selected mode and missing settings without exposing values.

## PEM file selection

The sample TOML contains private_key_file to keep the API user's PEM file outside source control and ready for SDK signer configuration. Important: the PEM file does not authenticate a client-credentials service token. The service token identifies a service caller. The PEM key is an API-user signing key and is only relevant to signed-challenge authentication or user-signed intent operations. Do not assume the service identity can approve or sign user intents. No intent operation is enabled in this integration.

Generate the API-user key locally using Ripple's official SDK helper when the SDK package has been provided by Ripple, register only its public key with the Ripple administrator, and protect the PEM file with owner-only permissions (0600). Never send the PEM private key to ChatGPT, GitHub, or Ripple support.

## Install the official SDK

Ripple currently distributes the TypeScript SDK as a versioned package file, not as a normal public npm install. Obtain the exact .tgz package from Ripple Support and install it into this project, for example:

    npm install ./ripple-ripple-custody-client-lib-typescript-<version>.tgz

Use the exact tested version supplied by Ripple. The documented TypeScript SDK requires Node.js 22.19 or later. This repository does not vendor a fabricated SDK package. Until the official package is installed and deployment settings are provisioned, the integration reports the SDK/configuration unavailable and fails closed.

## Configuration

Copy config/ripple-custody.example.toml to config/ripple-custody.toml on the server and replace all placeholders with Ripple-issued values: Vault API HTTPS origin, OIDC issuer URL, client ID, private key file path, domain ID if required, and notary API public key (base64 DER). Response verification remains enabled.

Set RC_CLIENT_SECRET in the server's secret manager/environment. The app needs only RC_CONFIG_FILE if you choose a non-default TOML location; the default path avoids even that variable. The secret itself cannot safely be eliminated or invented. Ripple must provision it.

The supplied OpenAPI file has no server URL and does not provide an actual deployment endpoint, OIDC issuer, service client, secret, notary public key, domain, or ledger IDs. Do not substitute the separate Ripple Wallet API sandbox URL for a Vault deployment.

## Safety and accounting boundaries

- Restricted TRX-denominated credits remain in the separate append-only internal ledger and are not Ripple custody assets, native TRX, or Bitpie wallet balance.
- All provider mutations, withdrawals, internal transfers, intent proposals/approvals/rejections, and Gas Station writes remain disabled.
- Mainnet real-value execution remains disabled. No environment variable alone can enable it.
- Bitpie API balance/deposit writes remain unsupported; address validation is not a wallet credit.
- The current SDK adapter exposes only the domain-list operation. Other provider read endpoints return 501 until implemented against exact SDK methods and verified against the SDK version Ripple supplies.

## Operational checks

1. Install the Ripple-provided SDK .tgz and use Node.js 22.19+.
2. Copy and fill the TOML file with values from the Vault administrator.
3. Add the service client secret to the backend secret manager as RC_CLIENT_SECRET.
4. Ensure the PEM path is readable only by the application service account (0600).
5. Confirm response verification succeeds and the service caller can list its authorized domains in a provider-approved non-production environment.
6. Keep all write and Mainnet paths disabled pending provider policy confirmation, exact SDK method coverage, test-environment verification, and independent security review.

## Accounting boundary

Ripple Omnibus virtual-account balances are provider accounting records. Tron Transfer restricted credits are separate application-ledger entries. Actual TRX is held by the configured custody provider or observed on-chain. Do not add these values together or describe internal credits as a Bitpie deposit.

## Owner-only restricted-credit workspace

Restricted-credit lookup and allocations are available only inside the private Tron Transfer owner workspace. The customer self-service route and customer wallet-session credit endpoint have been removed. Owner allocations remain internal ledger entries denominated in integer SUN; they are not actual TRX, 1TRAX contract tokens, or Bitpie deposits.

The separate 1TRAX testnet contract and reserve reconciliation are documented in docs/1TRAX_TESTNET_ARCHITECTURE.md. Do not combine internal credit entries, 1TRAX total supply, and actual native TRX reserve balances.


## What is not delivered by this ledger

- It does not transfer real TRX.
- It does not make a Bitpie app display a restricted balance.
- It does not prove the customer owns a Bitpie account or that the destination address belongs to Bitpie.
- It does not provide a TRX withdrawal or gas fee funding path.
- A Bitpie balance can only reflect blockchain assets Bitpie recognizes at the actual address, subject to its own wallet implementation and network support.

For actual TRX custody/deposits/withdrawals and fees, Ripple must provision the deployment and service identity and the exact SDK package must be installed. Provider-side account/tenant, asset ticker, intent-signing and Gas Station APIs must then be implemented and verified. No live Mainnet writes are enabled.
