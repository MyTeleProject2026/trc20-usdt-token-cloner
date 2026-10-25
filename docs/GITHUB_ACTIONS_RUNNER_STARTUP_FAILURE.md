# GitHub Actions: jobs failing before runner startup

## Observed evidence

The sponsor integration PR's validation runs are failing before a runner executes workflow code. Earlier examples:

- CI run: https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/actions/runs/40130379704
  - Retry attempt 2: 2026-10-24 20:35:18–20:35:20 UTC
  - Jobs: `120980845442` (Node 24.x), `120980845652` (Node 22.x)
- Earlier CI run: https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/actions/runs/40129678326
- Dependency security audit: https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/actions/runs/40130379685

The inspected job records show `runner_id: 0`, an empty `runner_name`, and `steps: []`. They end within seconds. Therefore, `actions/checkout`, Node setup, `npm ci`, automated tests, the build, and `npm audit` were not reached. These runs are **not** passing or failing test assertions; test/build results are unknown until a runner actually executes the steps.

### Runner-image isolation attempt (25 Oct 2026)

The CI workflow was changed from `ubuntu-latest` to the explicit `ubuntu-24.04` image in commit `a232fd2516ef3856c561f37221c47258fa883956`. Fresh run [40168839169](https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/actions/runs/40168839169) still failed within two seconds: job `121095362138`, `runner_id: 0`, empty `runner_name`, and `steps: []`; its only runner label was `ubuntu-24.04`. Therefore, pinning the Ubuntu image did not fix the problem, and no install, tests, build or audit ran. This is evidence of a runner allocation/control-plane or account/repository policy issue, not evidence of a source-code test failure.

At the time of earlier inspection, GitHub's public status page listed Actions as operational. Public status does not rule out an account quota, repository setting, organization policy, or repository-specific runner assignment issue.

## Workflow changes already made

- `.github/workflows/ci.yml` is the sole PR validation workflow, pins `ubuntu-24.04`, uses Node 24 with the isolated PostgreSQL service, and includes the critical/high dependency-audit gate in the same job to reduce hosted-runner demand.
- `.github/workflows/verify.yml` and `.github/workflows/webpack.yml` only run on `main` or manual dispatch, avoiding duplicate full test/build runs on every PR.
- `.github/workflows/dependency-audit.yml` remains available on pushes to `main`, scheduled runs, and manual dispatch; it produces the detailed audit artifact there.
- The dependency-audit summary's Total row formatting was corrected in commit `f343f101db8bc44e8c4ae45fdcae879ddbd8cd88`.

These changes reduce duplicate runs and correct a report-format issue. They cannot fix an account-level, repository-policy or GitHub-hosted runner allocation problem.

## Recommended resolution steps

1. Open repository **Settings → Actions → General** and verify GitHub Actions is enabled and the configured Actions policy permits GitHub-maintained checkout and Node setup actions. If an organization or enterprise policy overrides the repository, an owner must inspect that policy.
2. Check the owning account's GitHub Actions plan, included minutes, usage and spending/budget limits. Private repositories' hosted-runner usage depends on the account plan and quota; confirm Actions are available for this repository's plan.
3. After verifying those settings, retry CI once. Keep all test/build/security steps enabled; do not remove assertions or turn failed checks into success.
4. If a fresh retry still has `runner_id: 0` and no steps, contact GitHub Support and provide the run URLs above, job IDs, UTC timestamps, both runner labels (`ubuntu-latest` and `ubuntu-24.04`), and the empty-steps evidence. Include the private repository name when opening the support case.

Useful official documentation:
- https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository
- https://docs.github.com/en/actions/concepts/billing-and-usage
- https://www.githubstatus.com/

## Release rule

Do not treat a green-looking PR, a queued rerun, or a status endpoint as a successful test run. Production release remains blocked until test/build jobs actually execute and pass, a supported testnet end-to-end flow has real independently verified evidence, and sponsor consent, fee funding, signer authorization, and settlement verification have been reviewed. No user-funded fallback is allowed.
