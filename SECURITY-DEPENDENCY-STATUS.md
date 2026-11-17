# Dependency security scope and temporary build-tool exception

## Current status

The production dependency graph is clean under the blocking audit: the latest CI run reported zero production advisories. The complete development/build graph still reports four high findings: `fdir`, `picomatch`, `tinyglobby`, and `vite`.

The Picomatch finding is GHSA-fc5q-39xc-vjpf (CVE-2026-112366), a ReDoS issue affecting upstream Picomatch through 4.0.7. The lockfile currently contains Picomatch 4.0.5 and 4.0.7 in the Vite/tinyglobby dependency tree. The GitHub Advisory Database currently lists no patched Picomatch version. Do not describe this finding as fixed.

The automated npm audit suggestion to move Vite to 6.2.7 is not an accepted remediation: it is a downgrade from the locked 6.4.5 toolchain, npm marks it as a semver-major fix, and it does not establish that the Picomatch advisory is patched. Do not apply that suggestion without validating the resulting dependency tree and build compatibility.

## Scope decision

- Root Vite and `@vitejs/plugin-react` are build-only tools. The deployed Express/resource API starts with `node server/index.mjs`; it does not import Vite.
- The TRӾ frontend uses Vite, its React plugin, and solc during local/CI/Render asset generation. They are not browser runtime dependencies and are not shipped as part of the generated static asset bundle.
- Vite and its affected glob-matching dependencies are classified as `devDependencies` in the package manifests and root lockfile.
- The production audit (`npm audit --omit=dev`) remains blocking for critical/high findings. CI also reports the complete dependency audit so build-tool advisories remain visible rather than suppressed.
- The CI scope guard now checks every locked copy of Vite, the React plugin, tinyglobby, fdir, and Picomatch, not only the currently observed nested paths. This prevents a future npm lockfile reshuffle from silently placing another copy in the production dependency graph.

## Risk and mitigations

This is a scope reduction, not an upstream patch or a clean full-graph audit. Build tools still execute in CI and during Render builds. Vite is used to build trusted repository sources; the deployed resource API does not expose an endpoint that accepts user-controlled glob patterns and passes them to Picomatch. CI workflow permissions remain read-only for repository contents. The full-graph audit continues to report the four high findings and remains a release blocker under the current policy.

When upstream publishes a verified Picomatch fix and compatible dependency releases are available, update the Vite-compatible dependency chain, remove this temporary exception, and require both production and full-graph audits to pass before release.

Do not use a forced Vite downgrade or an unverified third-party fork as a substitute for a reviewed fix.
