# Dependency security candidate review

This document records the dependency candidate generated for PR #27. It is not a statement that all findings are resolved.

## Candidate versions

The generated lockfile resolves:

- `axios`: 1.20.0
- `tmp`: 0.2.7
- `ws`: 8.22.0
- `ethers`: 6.17.0
- `tronweb`: 6.5.1
- `solc`: 0.8.37

The candidate audit reported 9 remaining advisories: 0 critical, 6 high, and 3 moderate.

## Remaining migration work

The current report continues to flag Vite 5 and Tailwind CSS 3 dependency trees. Their reported remediation requires major-version migrations. These should be handled in separate branches with explicit build, test, and deployment compatibility checks; do not use `npm audit fix --force` to bypass those checks.

## Rollout policy

- Review CI, application verification, and contract compilation for the exact candidate lockfile.
- Do not merge solely because the audit count decreased.
- Keep the production environment and Render configuration unchanged until the candidate is reviewed and deployed through the normal release path.
- This dependency update does not sign or broadcast blockchain transactions, credit balances, or enable sponsorship.
