# Dependency security status — 2026-11-18

## Release gate

The full dependency audit is intentionally fail-closed for critical and high advisories. Do not bypass this gate or relabel an affected dependency as safe merely because it is used by build tooling.

## Current finding

The 2026-11-17 update to GitHub Advisory **GHSA-fc5q-39xc-vjpf** / **CVE-2026-112366** affects picomatch versions through 4.0.7. It describes regular-expression denial of service from crafted single-branch repeated extglob patterns. The advisory currently states no fixed release version.

- Advisory: https://github.com/advisories/GHSA-fc5q-39xc-vjpf
- CVE: https://nvd.nist.gov/vuln/detail/CVE-2026-112366
- Upstream remediation proposal: https://github.com/micromatch/picomatch/pull/194

The repository's current dependency tree includes picomatch 4.0.5 and 4.0.7 transitively through Vite/tinyglobby. npm audit also reports fdir, tinyglobby and Vite as high severity, with an automated Vite downgrade suggestion. That suggestion does not resolve the independently reported picomatch advisory and must not be treated as a complete remediation.

## Required remediation procedure

1. Wait for an upstream picomatch patch to be reviewed and released, or perform an explicitly reviewed vendoring/fork decision. Do not point production dependencies at an unmerged upstream PR.
2. Upgrade the affected transitive dependency through a supported upstream release or a reviewed override.
3. Regenerate package-lock.json using the repository's pinned Node/npm toolchain; never hand-edit package integrity metadata.
4. Run `npm ci`, the complete test suite, contract compilation and frontend build on the exact candidate commit.
5. Run `npm audit` and verify zero critical/high findings. Preserve the CI release gate.
6. Re-run the audit after merging to main and before production deployment.

## Current verification

- Dependabot PR #187 dependency update was merged as `8c070cb486a4b0af5cb33a933a6f1572339a2e3c`.
- The main-branch Node 22/24 build matrix passed after that merge.
- The subsequent full npm audit still reports four high findings, including the no-fixed-version picomatch advisory. Therefore the security release gate remains blocked.
- PR #199 was updated to use the audited main-branch package.json and package-lock.json; its own CI/audit reruns are tracked independently.

## Deployment policy

No production deployment or owner-wallet contract broadcast is authorized by a passing build alone. Keep deployment blocked until the security gate passes and the exact Mainnet resource simulation independently confirms sufficient Energy, Bandwidth and the intended fee ceiling.
