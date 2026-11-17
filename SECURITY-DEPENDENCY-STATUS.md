# Dependency security scope and temporary build-tool exception

## Current status

The production dependency graph is clean under the blocking audit. The full development/build graph still reports four high findings because Vite 6.4.5 depends on the tinyglobby / fdir / picomatch chain. The Picomatch advisory is GHSA-fc5q-39xc-vjpf (CVE-2026-112366), a ReDoS issue affecting upstream Picomatch through 4.0.7.

No upstream fixed Picomatch release is listed by the advisory at the time this status was recorded. Do not describe the advisory as fixed.

## Scope decision

- Root Vite and @vitejs/plugin-react are build-only tools. The deployed Express/resource API starts with node server/index.mjs; it does not import Vite.
- The TRӾ frontend uses Vite, its React plugin, and solc during local/CI/Render asset generation. They are not browser runtime dependencies and are not shipped as part of the generated static asset bundle.
- These tools are classified as devDependencies in both package manifests and in the root lockfile.
- The production audit (npm audit --omit=dev) remains blocking for critical/high findings. CI also runs and reports the complete dependency audit so build-tool advisories remain visible rather than suppressed.
- A CI scope check ensures the Vite/Picomatch chain cannot silently drift back into the production dependency graph.

## Risk and mitigations

This is a scope reduction, not an upstream patch. Build tools still execute in CI and during Render builds. Vite is used only to build trusted repository sources; this application does not expose a runtime endpoint that accepts user-controlled glob patterns and passes them to Picomatch. CI workflow permissions remain read-only for repository contents. The full-graph audit continues to display the high findings.

When upstream publishes a verified Picomatch fix, update the Vite-compatible dependency chain, remove this temporary exception, and require both production and full-graph audits to pass before release.

Do not use a forced Vite downgrade or an unverified third-party fork as a substitute for a reviewed fix.
