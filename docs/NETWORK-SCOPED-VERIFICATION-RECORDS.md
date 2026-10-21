# Network-scoped verification records

Transfer verification history is scoped by the exact TRON environment: `mainnet`, `shasta`, or `nile`.

## Legacy records

Older database installations may contain `transfer_verifications.network = 'TRON'`. Those rows predate explicit network persistence and are **unclassified**. Do not reinterpret them as Mainnet and do not rewrite them to Shasta or Nile without independently verified chain evidence.

The application initialization migration removes the legacy column default so new direct inserts cannot silently acquire the generic `TRON` label. The application write path rejects missing or unsupported networks. New rows must supply one of the explicit network values.

## Safe verification rules

- A verification record is evidence metadata, not a wallet balance or an exchange credit.
- Keep network, transaction hash, and token contract as the record identity.
- Do not migrate ambiguous historical rows based only on their transaction hash or a display label.
- Back up the database before any manual cleanup or migration.
- Treat an unclassified legacy record as inconclusive until its network is independently established.
