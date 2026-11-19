# Live Runtime Observatory

The Owner Admin Home includes a read-only Runtime Observatory backed by the resource API process.

## Endpoints

- `GET /api/observatory/snapshot`: current process heartbeat, uptime since process start, memory, event-loop delay, rolling 60-second HTTP request metrics, bounded sample history, and sanitized API request events.
- `GET /api/observatory/transactions?address=<owner>`: confirmed-only TRON Mainnet account transaction history from TronGrid v1.

The transaction feed is restricted to the configured owner wallet. It uses `only_confirmed=true`, limits each page to 20 records, and never submits or signs transactions.

## Sampling and retention

The backend heartbeat samples its own process once per second. The browser reads this snapshot once per second. Confirmed chain transactions are refreshed every ten seconds to avoid unnecessarily frequent history queries.

Runtime samples and request events are held in bounded process memory. They are lost when Render restarts or suspends the service. Durable external uptime probe history is separately stored on the Git-backed `monitoring-history` branch as described below; this does not make one-second process telemetry durable or guarantee 24/7 availability. The current PostgreSQL resource remains suspended.

## Render integration

The backend exposes `GET /api/observatory/render-events` for recent service lifecycle events. It reads the Render API using a server-side bearer token and returns only event ID, service label, event type, and timestamp; event details and credentials are not forwarded to the browser. It polls the resource API and frontend service event endpoints every 30 seconds.

Configure these environment variables on the resource API service to enable it:

- `RENDER_API_KEY` (secret; never place this in frontend build variables)
- `RENDER_RESOURCE_API_SERVICE_ID` (defaults to the current resource API service ID)
- `RENDER_FRONTEND_SERVICE_ID` (defaults to the current frontend service ID)

If the API key is absent, the endpoint returns `configured: false` and the UI shows the integration as not configured rather than inventing deploy events. Render authenticates API calls with a bearer API key and exposes recent service events at `/v1/services/{serviceId}/events`.

Render platform metrics have a coarser sampling interval than the process heartbeat; do not interpolate them into one-second measurements.

## Safety

- No transaction is created, signed, or broadcast by the observatory.
- Owner addresses and query strings are removed from request-event paths.
- The transaction history endpoint only reads confirmed records.
- Resource claims and deployment authorization continue to use their existing wallet approval safeguards.


## Live dashboard presentation

The Owner Admin Home renders a five-node topology for the browser console, resource API, TRON Mainnet, TEnergy, and Render control plane. The browser polls the process snapshot every second with a single-flight guard and a seven-second request timeout. The UI shows a local clock, last snapshot age, measured browser-to-API request time, heartbeat age, process uptime, RSS/heap, event-loop p95, request counts, errors and latency. A heartbeat older than 3.5 seconds is shown as stale/degraded; the UI does not keep a green LIVE state when fresh samples stop arriving. Confirmed owner-wallet history is refreshed every ten seconds, and Render lifecycle events every 30 seconds. The display is responsive and includes animated connection pulses and a state legend. The one-second signal is the application process heartbeat, not a Render platform metric or an external 24/7 uptime guarantee.

The dashboard's manual refresh action requests a fresh process snapshot and refreshes both external event feeds. Runtime snapshot requests are single-flight so slow responses cannot build up overlapping one-second polling calls.

## External uptime history and incident automation

The production uptime workflow runs on a five-minute GitHub Actions schedule (best effort; GitHub does not guarantee exact schedule start times) and can also be started manually. It probes the production frontend, resource API health endpoint, and Runtime Observatory snapshot. A snapshot is considered healthy only when its process heartbeat is recent; checks exceeding the five-second response threshold fail the probe.

Each run writes a JSON report and retains it as a GitHub Actions artifact for 90 days. It also appends the complete sanitized probe result to a date-partitioned JSON file on the dedicated `monitoring-history` branch using the workflow-scoped `GITHUB_TOKEN`. The archive is committed on every probe; Git preserves prior versions of each daily file, so history survives Render restarts and is not limited to the artifact's 90-day retention. The observatory exposes `GET /api/observatory/uptime-history`, which reads the current and previous UTC day's persistent records from the public archive branch. The endpoint is read-only, rate-limited, and cached for 60 seconds. The dashboard polls it every 60 seconds and links to the full workflow run.

The runtime-observatory probe also archives a sanitized five-minute sample of process uptime, heartbeat success/misses, RSS and heap memory, event-loop p95, request counts, 5xx errors, error rate, and API latency. The dashboard displays these archived process samples beside each uptime result; they are snapshots at probe time, not continuous one-second history. The workflow also maintains one deduplicated GitHub issue titled `[Production Monitor] Tron Transfer availability incident`. A failed check opens the issue or updates the existing open incident. The first fully healthy check after an incident closes it and records the recovery workflow. This provides repository-native incident notifications; GitHub notification delivery depends on each user's GitHub notification settings.

## Retention and platform limitations

- Detailed probe JSON artifacts are retained for 90 days as a convenient download; the durable source of record is the `monitoring-history` Git branch, whose commit history preserves prior daily archive versions.
- Incident history remains in the GitHub issue timeline after the incident is closed.
- The observatory's one-second process telemetry remains volatile and resets on API process restart.
- Render platform metrics are not currently available through the connected workspace metrics query (the latest query returned empty data points). The dashboard must not infer CPU, memory, bandwidth, or HTTP platform metrics from process telemetry.
- The Render PostgreSQL instance visible in the workspace is suspended for billing and expired. Durable application-side time-series storage is therefore not enabled by this release.
- Render lifecycle events remain a separate authenticated integration. Configure a newly rotated `RENDER_API_KEY` only as a server-side secret on the resource API service; never put it in frontend variables or source control.


## Render platform metrics integration

The resource API exposes `GET /api/observatory/render-metrics`. When a server-side `RENDER_API_KEY` is configured, it reads Render's documented CPU, memory, HTTP request, HTTP latency p95, and outbound bandwidth metrics for the resource API and frontend services. The response is normalized, read-only, cached for five minutes, and rate-limited. The dashboard polls the endpoint once per minute and displays the most recent platform samples separately from the one-second Node.js process telemetry.

Render's API can return empty series or reject metrics that are unsupported by a service type or workspace plan. Those cases are shown as `No data` or `Unavailable`; the dashboard does not infer platform metrics from process-local measurements. The static frontend does not expose CPU/memory or web-service HTTP metrics, so those are requested only for the resource API; outbound bandwidth is requested for both services.
