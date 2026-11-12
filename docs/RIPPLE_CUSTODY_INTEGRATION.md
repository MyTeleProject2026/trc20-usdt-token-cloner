# Ripple Custody integration — safe implementation baseline

## Source and scope

This integration is based on the supplied Ripple Custody (Vault) OpenAPI 3.0.1 document. It declares Bearer authentication, /v1 API paths, Omnibus and tenant operations, deposit-wallet operations, withdrawal initiation, intent proposal/approval/rejection, and Gas Station sponsor configuration and read operations. It does not declare a server URL. Configure the actual provider HTTPS origin and issued bearer token through backend secrets.

The supplied OpenAPI document has no Bitpie API paths. The Bitpie adapter therefore validates TRON address syntax only and reports balance reads, deposits, notifications, and balance writes as unsupported. Do not create an artificial Bitpie balance or describe Tron Transfer internal credits as a Bitpie deposit.

## Implemented in this baseline

- Backend-only Ripple Bearer token configuration.
- HTTPS-origin validation and sanitized provider errors.
- Read-only access to domains, vaults, Omnibus, tenants, tenant deposit-wallet status, account balances, confirmed balances, intents, and Gas Station sponsor information.
- Separate append-only PostgreSQL restricted-credit ledger. Amounts are integer SUN strings, and ledger records are explicitly labelled TRX-denominated-internal-credit / internal-ledger.
- Owner-session protection for administrative reads and credit allocation.
- Idempotent restricted-credit allocation with account-row locking and immutable entries.
- Bitpie address-format validation without asserting account ownership or native wallet balance.

## Deliberately disabled

All Ripple mutations are blocked before an HTTP request, including Omnibus/tenant creation, deposit-wallet creation, internal transfers, withdrawal initiation, intent proposal/approval/rejection, and Gas Station sponsor configuration changes. This build does not create an unsigned withdrawal intent or approve, sign, or broadcast a withdrawal. The existing treasury route's hard-coded real-value execution lock remains intact.

The uploaded OpenAPI specification is an API contract, not evidence of an activated Ripple tenant, supported TRON Mainnet ledger, provider policy, signing authority, Gas Station funding, or test account. Before enabling any mutation, obtain the provider's actual environment details, verify the network and TRX ticker/ledger IDs, implement request-body schemas exactly as specified, test against a provider-approved non-production environment, and complete independent security review. Never enable Mainnet execution by setting an environment variable alone.

## Environment

- RIPPLE_CUSTODY_API_BASE: provider-issued HTTPS API origin (the OpenAPI file has no server URL).
- RIPPLE_CUSTODY_BEARER_TOKEN: provider-issued Bearer token; backend secret only.
- RIPPLE_CUSTODY_DOMAIN_ID: configured provider domain ID.
- RIPPLE_CUSTODY_OMNIBUS_ID: configured Omnibus ID.
- RIPPLE_CUSTODY_TRX_TICKER_ID: verified native TRX ticker UUID.
- RIPPLE_CUSTODY_TRON_LEDGER_ID: verified TRON ledger ID.
- RIPPLE_CUSTODY_NETWORK: operator-supplied label for display; not independently verified by this adapter.

Never place these values in VITE variables, client bundles, source control, or logs.

## Accounting boundary

Ripple Omnibus virtual-account balances are provider accounting records. Tron Transfer restricted credits are a separate application ledger. Actual TRX is held by the configured custody provider or observed on-chain. Do not sum these values into one balance. A Ripple virtual account is not the same thing as a Tron Transfer restricted-credit account, and neither is a Bitpie app balance.

The Ripple position-report schema describes three account types: omnibus, deposit wallet, and virtual account. Its control totals must not be summed across account types because the omnibus pool backs the virtual rows; doing so double-counts by construction.

## Routes

All routes below require the existing owner session (Bearer session token and allowed Origin):

- GET /api/ripple-custody/status
- GET /api/ripple-custody/domains
- GET /api/ripple-custody/domains/:domainId/omnibus
- GET /api/ripple-custody/domains/:domainId/omnibus/:omnibusId/tenants
- GET /api/ripple-custody/domains/:domainId/omnibus/:omnibusId/tenants/:tenantId/deposit-wallet
- GET /api/ripple-custody/domains/:domainId/intents
- GET /api/ripple-custody/domains/:domainId/transactions and transaction details
- GET /api/ripple-custody/domains/:domainId/events
- GET /api/ripple-custody/domains/:domainId/sponsors
- GET /api/ripple-custody/credits/:customerId
- POST /api/ripple-custody/credits/allocate
- GET /api/ripple-custody/bitpie/capabilities
- POST /api/ripple-custody/bitpie/validate-address

Credit allocation body: { "customerId": "...", "amountSun": "100000000", "idempotencyKey": "...", "reason": "..." }. One TRX equals 1,000,000 SUN. Allocation is internal bookkeeping only and cannot be used as an on-chain withdrawal source.
