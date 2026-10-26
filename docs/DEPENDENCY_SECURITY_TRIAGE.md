# Dependency security triage

**Reviewed:** 2026-10-26 (candidate remediation pending CI)  
**Scope:** Runtime dependency advisories affecting TRON Token Studio.

## Current finding: google-protobuf runtime

Render's `npm install` output for the API service reported one high-severity vulnerability. The repository lockfile resolves:

- `tronweb@6.5.1`
- `google-protobuf@3.21.4`, pulled by TronWeb's exact dependency pin.

The official [GHSA-5h29-r2cp-hfmr advisory](https://github.com/protocolbuffers/protobuf-javascript/security/advisories/GHSA-5h29-r2cp-hfmr) reports uncontrolled recursion in `BinaryReader.skipGroup()`, affecting `google-protobuf <= 4.0.2`; upstream lists `4.0.3` as patched. The locked 3.21.4 runtime is within the affected range. This finding must remain visible and is tracked in [issue #49](https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/issues/49).

### Exposure review

TronWeb's generated transaction utilities use protobuf `deserializeBinary()` when decoding raw transaction data. Repository searches found no direct calls to `deserializeBinary`, `rawDataHex`, or `getRowBytesFromTransactionBase64` in this application's own `src/` or `server/` code. Current server routes pass validated addresses and transaction hashes to read-only JSON API endpoints rather than accepting a user-provided serialized protobuf transaction blob.

This reduces evidence of a directly reachable attack path in the current application, but it does **not** remove the vulnerable transitive dependency or prove zero risk. Do not describe this finding as fixed.

### Candidate remediation on an isolated branch

The branch `fix/google-protobuf-4-0-3-security` stages an exact npm override to `google-protobuf@4.0.3`. This is a candidate, not a declaration that the advisory is resolved. The branch-specific workflow regenerates `package-lock.json` with npm rather than hand-editing the dependency graph or inventing integrity metadata.

The override crosses the major runtime boundary from the exact `3.21.4` version pinned by TronWeb v6.5.1. The branch adds a regression test that checks the installed version, builds and deserializes a local TRC-20 transaction, and signs it with an ephemeral test key. The test uses `txLocal` and does not broadcast or contact a blockchain node. This checks important compatibility behavior but is not a substitute for the full test suite, build, and audit.

Do not mark the advisory fixed unless the generated lockfile resolves `google-protobuf@4.0.3`, `npm ci` succeeds, the full CI test/build workflow succeeds, and `npm audit` reports no remaining critical/high advisories. If the compatibility check fails, do not merge the override; evaluate a compatible upstream TronWeb release or a different tested remediation. Do not suppress the audit gate.

### Required release actions

- [ ] Obtain generated lockfile output for the candidate branch and confirm the resolved runtime is exactly `4.0.3`.
- [ ] Run `npm ci`, the complete test suite, and the production build in GitHub Actions.
- [ ] Verify the new local transaction encode/decode/sign test passes and does not broadcast.
- [ ] Check `npm audit` and confirm the high-severity advisory no longer appears.
- [ ] Review any remaining dependency advisories and the compatibility risk before accepting the override.
- [ ] Only after a separately approved release/deployment, verify the deployed service remains healthy; no deployment is part of this candidate change.

Until these pass, keep the high-severity advisory tracked as open. A successful Render build/start is not a substitute for an audit result or compatibility test.
