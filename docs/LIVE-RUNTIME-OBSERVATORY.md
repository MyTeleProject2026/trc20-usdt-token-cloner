# Live Runtime Observatory

The Owner Admin Home includes a read-only Runtime Observatory backed by the resource API process.

## Endpoints

- `GET /api/observatory/snapshot`: current process heartbeat, uptime since process start, memory, event-loop delay, rolling 60-second HTTP request metrics, bounded sample history, and sanitized API request events.
- `GET /api/observatory/transactions?address=<owner>`: confirmed-only TRON Mainnet account transaction history from TronGrid v1.

The transaction feed is restricted to the configured owner wallet. It uses `only_confirmed=true`, limits each page to 20 records, and never submits or signs transactions.

## Sampling and retention

The backend heartbeat samples its own process once per second. The browser reads this snapshot once per second. Confirmed chain transactions are refreshed every ten seconds to avoid unnecessarily frequent history queries.

Runtime samples and request events are held in bounded process memory. They are lost when Render restarts or suspends the service. The current PostgreSQL resource is suspended, so this release does not claim durable history or 24/7 availability.

## Render integration boundary

Render control-plane events, deploy state, and platform metrics are not queried directly by the application in this release. The Render account exposes those through its authenticated control plane. Do not put a Render API key in frontend code. A future server-side integration may use a secret `RENDER_API_KEY` after it is provisioned in the Render service environment.

Render platform metrics have a coarser sampling interval than the process heartbeat; do not interpolate them into one-second measurements.

## Safety

- No transaction is created, signed, or broadcast by the observatory.
- Owner addresses and query strings are removed from request-event paths.
- The transaction history endpoint only reads confirmed records.
- Resource claims and deployment authorization continue to use their existing wallet approval safeguards.
