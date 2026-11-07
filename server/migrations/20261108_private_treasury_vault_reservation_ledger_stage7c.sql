-- Stage 7C isolated provider-independent reservation ledger.
-- This migration is intentionally NOT registered with application startup.
-- It creates new tables only; it does not read, rewrite, or backfill legacy financial rows.
-- Reservation rows are internal accounting controls, not external custody holds or payout authority.

CREATE SCHEMA IF NOT EXISTS trc20_token_clone;

CREATE TABLE IF NOT EXISTS trc20_token_clone.private_treasury_vaults (
  vault_id UUID PRIMARY KEY,
  network TEXT NOT NULL CHECK (network = 'mainnet'),
  asset TEXT NOT NULL CHECK (asset = 'USDT'),
  token_contract TEXT NOT NULL
    CHECK (token_contract = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'),
  decimals SMALLINT NOT NULL CHECK (decimals = 6),
  vault_address TEXT NOT NULL CHECK (length(vault_address) BETWEEN 25 AND 64),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (network, token_contract, vault_address)
);

CREATE TABLE IF NOT EXISTS trc20_token_clone.private_treasury_observation_state (
  vault_id UUID PRIMARY KEY
    REFERENCES trc20_token_clone.private_treasury_vaults(vault_id) ON DELETE RESTRICT,
  last_sequence BIGINT NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  last_observation_id TEXT,
  last_receipt_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trc20_token_clone.private_treasury_observation_claims (
  claim_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vault_id UUID NOT NULL
    REFERENCES trc20_token_clone.private_treasury_vaults(vault_id) ON DELETE RESTRICT,
  receipt_id TEXT NOT NULL CHECK (length(receipt_id) BETWEEN 1 AND 200),
  observation_id TEXT NOT NULL CHECK (length(observation_id) BETWEEN 1 AND 200),
  reservation_sequence BIGINT NOT NULL CHECK (reservation_sequence > 0),
  payload_digest CHAR(64) NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vault_id, receipt_id),
  UNIQUE (vault_id, observation_id),
  UNIQUE (vault_id, reservation_sequence),
  UNIQUE (vault_id, receipt_id, observation_id, reservation_sequence)
);

CREATE OR REPLACE FUNCTION trc20_token_clone.enforce_private_treasury_sequence_exact_next()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.vault_id IS DISTINCT FROM OLD.vault_id THEN
    RAISE EXCEPTION 'private Treasury Vault observation-state identity is immutable' USING ERRCODE = '23514';
  END IF;

  IF NEW.last_sequence < OLD.last_sequence THEN
    RAISE EXCEPTION 'private Treasury Vault sequence cannot move backwards' USING ERRCODE = '23514';
  END IF;

  IF NEW.last_sequence = OLD.last_sequence THEN
    IF NEW.last_observation_id IS DISTINCT FROM OLD.last_observation_id
       OR NEW.last_receipt_id IS DISTINCT FROM OLD.last_receipt_id THEN
      RAISE EXCEPTION 'observation identity cannot change without advancing sequence' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.last_sequence <> OLD.last_sequence + 1 THEN
      RAISE EXCEPTION 'private Treasury Vault sequence must advance exactly one step' USING ERRCODE = '23514';
    END IF;

    IF NEW.last_observation_id IS NULL OR NEW.last_receipt_id IS NULL THEN
      RAISE EXCEPTION 'advancing observation sequence requires receipt and observation identities' USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM trc20_token_clone.private_treasury_observation_claims c
      WHERE c.vault_id = NEW.vault_id
        AND c.reservation_sequence = NEW.last_sequence
        AND c.observation_id = NEW.last_observation_id
        AND c.receipt_id = NEW.last_receipt_id
    ) THEN
      RAISE EXCEPTION 'advancing observation sequence requires a matching immutable claim' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS private_treasury_sequence_monotonic
  ON trc20_token_clone.private_treasury_observation_state;
CREATE TRIGGER private_treasury_sequence_monotonic
  BEFORE UPDATE ON trc20_token_clone.private_treasury_observation_state
  FOR EACH ROW EXECUTE FUNCTION trc20_token_clone.enforce_private_treasury_sequence_exact_next();

CREATE TABLE IF NOT EXISTS trc20_token_clone.private_treasury_reservations (
  reservation_id UUID PRIMARY KEY,
  vault_id UUID NOT NULL
    REFERENCES trc20_token_clone.private_treasury_vaults(vault_id) ON DELETE RESTRICT,
  request_id UUID NOT NULL,
  receipt_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  reservation_sequence BIGINT NOT NULL CHECK (reservation_sequence > 0),
  asset TEXT NOT NULL DEFAULT 'USDT' CHECK (asset = 'USDT'),
  token_contract TEXT NOT NULL
    DEFAULT 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
    CHECK (token_contract = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'),
  decimals SMALLINT NOT NULL DEFAULT 6 CHECK (decimals = 6),
  amount_base_units NUMERIC(78,0) NOT NULL
    CHECK (amount_base_units >= 1000000000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vault_id, request_id),
  UNIQUE (vault_id, reservation_id),
  UNIQUE (vault_id, reservation_sequence),
  FOREIGN KEY (vault_id, receipt_id, observation_id, reservation_sequence)
    REFERENCES trc20_token_clone.private_treasury_observation_claims
      (vault_id, receipt_id, observation_id, reservation_sequence)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS private_treasury_reservations_vault_created_idx
  ON trc20_token_clone.private_treasury_reservations(vault_id, created_at DESC);

CREATE TABLE IF NOT EXISTS trc20_token_clone.private_treasury_reservation_events (
  event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reservation_id UUID NOT NULL,
  vault_id UUID NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type = 'reservation-created'),
  event_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (vault_id, reservation_id)
    REFERENCES trc20_token_clone.private_treasury_reservations(vault_id, reservation_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS private_treasury_reservation_events_vault_created_idx
  ON trc20_token_clone.private_treasury_reservation_events(vault_id, created_at DESC);

CREATE TABLE IF NOT EXISTS trc20_token_clone.private_treasury_legacy_classifications (
  classification_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_table TEXT NOT NULL CHECK (source_table IN (
    'owner_treasury_verified_inflows',
    'sponsor_direct_payouts',
    'treasury_withdrawal_requests',
    'treasury_trx_withdrawal_requests'
  )),
  source_record_id TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN (
    'candidate',
    'settled-with-evidence',
    'unresolved',
    'unassigned',
    'quarantined'
  )),
  source_digest CHAR(64) NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  supersedes_classification_id BIGINT
    REFERENCES trc20_token_clone.private_treasury_legacy_classifications(classification_id)
    ON DELETE RESTRICT,
  classified_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Claims, reservations, events, and classification decisions are append-only.
-- Corrections must be represented by new classification records, never rewrites.
CREATE OR REPLACE FUNCTION trc20_token_clone.reject_private_treasury_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS private_treasury_observation_claims_immutable
  ON trc20_token_clone.private_treasury_observation_claims;
CREATE TRIGGER private_treasury_observation_claims_immutable
  BEFORE UPDATE OR DELETE ON trc20_token_clone.private_treasury_observation_claims
  FOR EACH ROW EXECUTE FUNCTION trc20_token_clone.reject_private_treasury_ledger_mutation();

DROP TRIGGER IF EXISTS private_treasury_reservations_immutable
  ON trc20_token_clone.private_treasury_reservations;
CREATE TRIGGER private_treasury_reservations_immutable
  BEFORE UPDATE OR DELETE ON trc20_token_clone.private_treasury_reservations
  FOR EACH ROW EXECUTE FUNCTION trc20_token_clone.reject_private_treasury_ledger_mutation();

DROP TRIGGER IF EXISTS private_treasury_reservation_events_immutable
  ON trc20_token_clone.private_treasury_reservation_events;
CREATE TRIGGER private_treasury_reservation_events_immutable
  BEFORE UPDATE OR DELETE ON trc20_token_clone.private_treasury_reservation_events
  FOR EACH ROW EXECUTE FUNCTION trc20_token_clone.reject_private_treasury_ledger_mutation();

DROP TRIGGER IF EXISTS private_treasury_legacy_classifications_immutable
  ON trc20_token_clone.private_treasury_legacy_classifications;
CREATE TRIGGER private_treasury_legacy_classifications_immutable
  BEFORE UPDATE OR DELETE ON trc20_token_clone.private_treasury_legacy_classifications
  FOR EACH ROW EXECUTE FUNCTION trc20_token_clone.reject_private_treasury_ledger_mutation();
