# Implementation status and persistence plan

## Verified source findings

- The independent token contract is named/symbolized `TRC20` / `VTRC`, uses 18 decimals, and is explicitly not official Tether USDT.
- The UI previously showed a static `> 58 Billion USDT` value beside a 6-decimal label. That value did not describe the independent contract. The UI now labels the independent token as VTRC/18 decimals and explains that supply must be read from the selected deployed contract.
- The sponsor status endpoint is intentionally disabled until a real sponsor, funding, testnet verification, and review are in place.
- The API source exposes `GET /health`; deployment health must be confirmed against the live service, not inferred from source.

## Database and Render constraints

The app's `AGENTS.md` states that the preview runtime has no durable storage. A persistent database is required for an auditable application-side intent/sponsor ledger, but on-chain truth must always be re-read and verified from TRON.

On 2026-10-20, the connected Render workspace was inspected. The TRON API and static site are deployed in **Oregon** on the free web-service plan. The workspace already has one active free PostgreSQL database named `tronlink-skills-sponsor-ledger`, also in Oregon, and Render rejected creation of another free database because the account has reached its one-active-free-database limit. That existing database belongs to another project and must not be repurposed or modified without explicit approval.

No paid database has been created. Before database-backed persistence can be enabled, the project owner must either (a) explicitly authorize sharing a separate schema in the existing database after reviewing the cross-project risk, or (b) free the existing free-tier slot / choose a different eligible workspace, then create a dedicated PostgreSQL database. Once provisioned, keep the connection string only in the Render backend environment as `DATABASE_URL`, use TLS, apply versioned migrations, and restrict the database role to the minimum required permissions.

## Release gates still outstanding

- Run `npm test` and `npm run build` on the branch and review CI results.
- Exercise the live `/health`, `/api/status`, and verification routes against the deployed backend.
- Confirm the frontend's production API origin and CORS allowlist.
- Do not enable mainnet sponsorship until a real funded sponsor and independent security review are documented.
- Never present a simulator record, independent VTRC token, or unverified transaction as official USDT or as a confirmed on-chain transfer.
