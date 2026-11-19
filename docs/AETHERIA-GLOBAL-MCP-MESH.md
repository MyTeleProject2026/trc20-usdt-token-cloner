# AETHERIA // GLOBAL MCP MESH

The Tron Transfer Owner Admin Home renders AETHERIA as the primary, read-only runtime monitoring surface. It binds each displayed hub to the existing Resource API endpoints and tracks the request dispatch, response status, measured latency, callback timestamp, and freshness age.

## Hub and function map

| Hub | Function | Endpoint |
|---|---|---|
| Resource API | \`platform.health.read\` | \`GET /health\` |
| Runtime Core | \`runtime.snapshot.read\` | \`GET /api/observatory/snapshot\` |
| TRON Mainnet | \`mainnet.resources.read\` | \`GET /v1/resources/{owner}\` |
| TEnergy | \`tenergy.promotion.status\` | \`GET /api/tron/tenergy/promo?address={owner}\` |
| TRON Mainnet | \`mainnet.confirmed.transactions\` | \`GET /api/observatory/transactions?address={owner}\` |
| Render Control Plane | \`render.service.events.list\` | \`GET /api/observatory/render-events\` |
| GitHub Archive | \`uptime.history.read\` | \`GET /api/observatory/uptime-history\` |
| Render Control Plane | \`render.metrics.read\` | \`GET /api/observatory/render-metrics\` |

Each API call is tracked as a one-to-one function flow. A successful response is the return callback; failures, HTTP status, latency, and callback state remain visible in the flow card and execution trace.

## One-second runtime tick and upstream sampling

The dashboard clock, callback ages, heartbeat freshness, and process snapshot update every second. The Resource API process itself samples its heartbeat once per second, and the browser reads the runtime snapshot once per second.

Other upstreams are intentionally polled at their supported intervals to respect API limits and avoid presenting cached values as fresh measurements:

- Resource API health: 1 second (lightweight local health route).
- TRON Mainnet account resources: 15 seconds (the backend resource cache is 15 seconds).
- TEnergy promotion status: 15 seconds.
- Confirmed owner-wallet transactions: 10 seconds.
- Render lifecycle events: 30 seconds.
- Git-backed uptime history: 60 seconds.
- Render platform metrics: 60 seconds in the browser; the backend applies a five-minute cache and a rate limit.

A one-second display tick does not mean Render's CPU, memory, bandwidth, or historical archive is sampled every second. Each value retains the timestamp/freshness of its real source response. Polling pauses when the browser tab is hidden and resumes when visible. Calls are single-flight per endpoint so slow responses do not accumulate overlapping requests.

## Render and archive data

- Render lifecycle events and platform metrics use a server-side \`RENDER_API_KEY\`. The credential is never sent to the browser.
- Render metric series may be unavailable or empty for a service type or workspace plan. The UI displays the source response honestly and never derives platform metrics from process memory.
- Uptime history is read from the Git-backed \`monitoring-history\` branch. It is not the same as one-second process history.
- Confirmed chain activity is read-only and owner-address restricted.

## Safety

AETHERIA is an observability UI. It does not sign, broadcast, deploy, mint, transfer, claim Energy, or change TRON contract state. Existing TronLink approval and exact Mainnet resource preflight protections remain unchanged. A green resource indicator is not a deployment authorization.
