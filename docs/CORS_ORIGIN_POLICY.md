# Browser CORS origin policy

The API uses `server/cors-policy.mjs` to enforce an explicit origin allowlist.

## Configuration

Set the backend-only `FRONTEND_ORIGIN` environment variable to the exact browser frontend origin (scheme + hostname + optional port). Multiple explicit origins may be comma-separated:

```text
FRONTEND_ORIGIN=https://trc20-usdt-token-cloner.onrender.com
```

Do not include paths, query strings, fragments, credentials, or wildcards. A trailing slash in the configured origin is normalized to the origin itself. HTTPS is required for non-local origins; plain HTTP is accepted only for `localhost`, `127.0.0.1`, or `::1` development origins. Invalid entries are ignored.

## Runtime behavior

- An incoming browser request with an `Origin` header is allowed only when its normalized origin is explicitly configured.
- When configuration is empty or invalid, browser-origin requests receive HTTP 403 and no `Access-Control-Allow-Origin` header is returned. The API never reflects arbitrary browser origins.
- Requests without an `Origin` header remain available to non-browser clients and server-to-server callers; CORS is not authentication.
- Allowed preflight requests receive HTTP 204 and advertise only `GET,POST,OPTIONS` and `Content-Type,Authorization`.
- The API does not enable credentialed CORS. Do not add cookies, bearer-token exposure, or wildcard origins to solve a frontend issue.
- The `/api/readiness` response reports `providers.frontendOrigin.configured` based on the normalized combined allowlist, so malformed entries do not appear configured. Browser-facing readiness is false until the database is ready, the read-only Tatum probe succeeds, and at least one valid browser origin is allowlisted; an API process that blocks every browser origin must not report full readiness.

CORS is a browser-enforced isolation control, not an authorization boundary. All privileged operations still require server-side authentication, authorization, strict field validation, replay protection and ledger controls.

## Verification

The behavior is covered by `tests/cors-policy.test.mjs`. The latest recorded CI run on main, [#40324586045](https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/actions/runs/40324586045), passed after the additive packaged-origin change. Continue to run the full suite after any CORS changes; a passing test is not a substitute for checking the deployed environment's actual allowlist.

## Packaged mobile and desktop app origins

The backend accepts an optional additive variable, `PACKAGED_APP_ORIGINS`, which is combined with `FRONTEND_ORIGIN` at startup. This lets operators enable packaged test clients without overwriting any previously configured web/admin origins. For the packaged apps built by this repository, set:

```text
PACKAGED_APP_ORIGINS=https://localhost,tronstudio://app
```

Only set it when enabling these reviewed test clients. Preserve the existing `FRONTEND_ORIGIN` value.

- `https://localhost` for the bundled Capacitor Android WebView.
- `tronstudio://app` for the packaged desktop shell.

The desktop origin is accepted only as the exact `tronstudio://app` host and must be explicitly present in either configured allowlist variable. No wildcard or opaque `null` origin is permitted. Do not add these origins unless you intend to enable API access from the corresponding packaged test applications.
