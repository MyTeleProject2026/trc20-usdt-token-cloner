# Dependency security remediation status

Updated after PRs #27–#29 were merged into `main`.

## Patched dependency lines

The current main-branch lockfile resolves the following versions:

- `axios`: 1.20.0
- `tmp`: 0.2.7
- `ws`: 8.22.0
- `ethers`: 6.17.0
- `tronweb`: 6.5.1
- `solc`: 0.8.37
- `vite`: 6.4.5
- `tailwindcss`: 4.3.3
- `@tailwindcss/postcss`: 4.3.3

The dependency audit on main commit `96e8ebd66a6d70c3777971d69b2a7d8ff8648158` completed successfully with `npm audit` reporting **0 vulnerabilities**. CI, application verification, and the Node.js build/contract compilation workflows also passed for that commit.

## Production rollout

Render deployment `dep-dbckpkrbc2fs738ieps0` is live on the same commit. The Render event stream reported a successful build and deployment. No application error-level logs were returned for the reviewed period. Render HTTP request metrics were empty, so these checks do not prove that external clients can reach every endpoint or that user-facing flows work end-to-end.

## Remaining operational checks

- Perform an external smoke test of `/health`, `/api/storage/status`, and `/api/readiness` from a network that can reach the public Render URL.
- The `/api/readiness` route requires both database readiness and a reachable read-only Tatum current-block endpoint. A provider failure should not be treated as proof of an application crash.
- Receiver history worker scheduling is still a separate opt-in operation. The worker remains disabled unless explicitly configured and scheduled; a successful API deployment does not mean background monitoring is active.
- Keep wallet signing/broadcast, sponsorship, and balance crediting disabled until their separate controls and verification gates are reviewed.

## Policy

Use the lockfile and CI checks for future dependency changes. Avoid `npm audit fix --force` for major migrations. Re-run the audit after dependency updates and investigate any new findings before deployment.
