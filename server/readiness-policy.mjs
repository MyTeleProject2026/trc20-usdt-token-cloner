/**
 * Overall browser-facing read-only readiness requires all dependencies that
 * the deployed UI needs: persistent storage, a reachable read-only provider,
 * and a valid explicit browser-origin allowlist.
 *
 * This deliberately says nothing about signing, sponsored submission, funding,
 * or successful on-chain transfers.
 */
export function isReadOnlyServiceReady({ database, providers } = {}) {
  return database?.ready === true
    && providers?.tatum?.reachable === true
    && providers?.frontendOrigin?.configured === true
}
