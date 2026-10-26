# Dependency security triage

**Reviewed:** 2026-10-26 (main remediation verified in CI)  
**Scope:** Runtime dependency advisories affecting TRON Token Studio.

## Current finding: google-protobuf runtime

The main branch now overrides TronWeb's transitive `google-protobuf` dependency to exactly `4.0.3`, and the committed npm lockfile resolves the same version. The official [GHSA-5h29-r2cp-hfmr advisory](https://github.com/protocolbuffers/protobuf-javascript/security/advisories/GHSA-5h29-r2cp-hfmr) identifies the affected runtime as `google-protobuf <= 4.0.2` and lists `4.0.3` as patched. This remediation is intended to remove the known affected runtime from the locked dependency tree.

The security remediation was merged to `main` in commit `0c79e562141fc0f5b5689add445a41a3a7073f15`. The follow-up packaging/desktop-origin changes are on current main `b35616626bc31ac8899aa6c6973e57ea2c2ce2e5`.

## Validation evidence

The following checks passed on the current main commit as of this review:

- Full Node.js test suite and PostgreSQL integration tests in [CI run #40323866510](https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/actions/runs/40323866510).
- Production build and contract compile on Node 22 and 24 in [build run #40323866512](https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/actions/runs/40323866512).
- Dependency security audit in [audit run #40323866563](https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/actions/runs/40323866563); npm reported zero critical and high advisories for the locked tree used in that run.
- The new `tests/protobuf-runtime-security.test.mjs` checks the resolved runtime and constructs, decodes, and locally signs a TRC-20 transaction using an ephemeral test key. The test is local-only and does not broadcast or contact a blockchain node.
- The post-deployment public API smoke check passed in [run #40324001497](https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/actions/runs/40324001497).

These results support that the locked runtime is patched and that current tested TronWeb encoding/decoding/signing paths pass. They are not a formal security certification, exhaustive malformed-protobuf fuzzing, or an endorsement of production sponsored transfers.

## Remaining dependency risk

The exact TronWeb dependency currently pins the older protobuf runtime, which is why the project must retain an explicit override and compatibility test until a compatible upstream TronWeb release adopts a patched runtime. A major-version protobuf override has compatibility risk even when these regression checks pass. Keep dependency audit gating enabled; do not suppress advisories or remove the regression test without an upstream dependency fix and replacement coverage.

## Required maintenance

- [x] Lock `google-protobuf@4.0.3` in package metadata and `package-lock.json`.
- [x] Pass `npm ci`, full application tests, PostgreSQL integration tests, and the production build.
- [x] Pass the critical/high dependency audit.
- [x] Verify the local transaction encoding/decoding/signing test does not broadcast.
- [ ] Monitor TronWeb releases for a compatible patched protobuf dependency and remove the override only with equivalent regression coverage.
- [ ] Continue adversarial/fuzz testing around transaction decoding as part of independent security review.
- [ ] Conduct separate production authorization, signer, provider, fee-settlement, and sponsor-go-live review.

The protobuf finding is remediated at the locked-runtime level for this main build; production sponsorship remains independently blocked until the sponsor go-live gates are evidenced. Successful Render startup or a clean dependency audit must not be described as proof of a live sponsored transfer.

Related tracking: [issue #49](https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/issues/49).
