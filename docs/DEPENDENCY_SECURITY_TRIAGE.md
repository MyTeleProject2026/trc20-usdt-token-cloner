# Dependency security triage

**Reviewed:** 2026-10-24  
**Scope:** Runtime dependency advisories affecting TRON Token Studio.

## Current finding: google-protobuf runtime

Render's `npm install` output for the API service reported one high-severity vulnerability. The repository lockfile resolves:

- `tronweb@6.5.1`
- `google-protobuf@3.21.4`, pulled by TronWeb's exact dependency pin.

The official [GHSA-5h29-r2cp-hfmr advisory](https://github.com/protocolbuffers/protobuf-javascript/security/advisories/GHSA-5h29-r2cp-hfmr) reports uncontrolled recursion in `BinaryReader.skipGroup()`, affecting `google-protobuf <= 4.0.2`; upstream lists `4.0.3` as patched. The locked 3.21.4 runtime is within the affected range. This finding must remain visible and is tracked in [issue #49](https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/issues/49).

### Exposure review

TronWeb's generated transaction utilities use protobuf `deserializeBinary()` when decoding raw transaction data. Repository searches found no direct calls to `deserializeBinary`, `rawDataHex`, or `getRowBytesFromTransactionBase64` in this application's own `src/` or `server/` code. Current server routes pass validated addresses and transaction hashes to read-only JSON API endpoints rather than accepting a user-provided serialized protobuf transaction blob.

This reduces evidence of a directly reachable attack path in the current application, but it does **not** remove the vulnerable transitive dependency or prove zero risk. Do not describe this finding as fixed.

### Why no blind package override was applied

The upstream TronWeb v6.5.1 manifest pins `google-protobuf@3.21.4`: [upstream package.json](https://github.com/tronprotocol/tronweb/blob/v6.5.1/package.json). The available patched runtime `google-protobuf@4.0.3` crosses a major runtime version; the 4.x line includes runtime behavior changes that may affect generated TronWeb message compatibility.

Forcing the override without executing the application and TronWeb serialization/deserialization tests could introduce a different transaction processing failure. The correct resolution is a compatible upstream TronWeb update, or an explicitly tested override. Do not edit the lockfile with invented integrity metadata or suppress the dependency-audit gate.

### Required release actions

- [ ] Restore GitHub Actions runner allocation and obtain actual test, build, and `npm audit` results.
- [ ] Upgrade to a compatible, patched runtime after testing; preferably use a TronWeb release that updates its pinned protobuf dependency.
- [ ] Run the app's full automated tests and build.
- [ ] Test TRON transaction encoding/decoding on testnet with valid, malformed and deeply nested protobuf payloads.
- [ ] Check `npm audit` and confirm the high-severity advisory no longer appears.
- [ ] Verify the deployed service remains healthy after the dependency change.

Until these pass, keep the high-severity advisory tracked as open. A successful Render build/start is not a substitute for an audit result or compatibility test.
