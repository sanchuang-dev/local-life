CREATE TABLE settlement_payment_records (
  id text PRIMARY KEY NOT NULL,
  statement_id text NOT NULL REFERENCES settlement_statements(id) ON DELETE restrict,
  community_id text NOT NULL REFERENCES communities(id) ON DELETE restrict,
  beneficiary_party_id text NOT NULL REFERENCES settlement_parties(id) ON DELETE restrict,
  beneficiary_role text NOT NULL,
  beneficiary_legal_name text NOT NULL,
  beneficiary_registry_ref text NOT NULL,
  beneficiary_verification_ref text,
  payable_cents_snapshot integer NOT NULL,
  amount_cents integer NOT NULL,
  paid_at integer NOT NULL,
  proof_ref_masked text NOT NULL,
  proof_fingerprint text NOT NULL,
  recorder_user_id text NOT NULL REFERENCES users(id) ON DELETE restrict,
  idempotency_key text NOT NULL,
  recorded_at integer NOT NULL,
  CONSTRAINT settlement_payment_record_role_check
    CHECK (beneficiary_role IN ('seller','sanchuang','guangdian')),
  CONSTRAINT settlement_payment_record_money_check
    CHECK (payable_cents_snapshot > 0 AND amount_cents > 0
      AND amount_cents <= payable_cents_snapshot)
);
--> statement-breakpoint
CREATE UNIQUE INDEX settlement_payment_proof_fingerprint_uq
  ON settlement_payment_records (proof_fingerprint);
--> statement-breakpoint
CREATE UNIQUE INDEX settlement_payment_record_idempotency_uq
  ON settlement_payment_records (idempotency_key);
--> statement-breakpoint
CREATE INDEX settlement_payment_statement_idx
  ON settlement_payment_records (statement_id, recorded_at);
--> statement-breakpoint
CREATE INDEX settlement_payment_beneficiary_idx
  ON settlement_payment_records (statement_id, beneficiary_party_id, recorded_at);
--> statement-breakpoint
CREATE TABLE settlement_payment_events (
  id text PRIMARY KEY NOT NULL,
  payment_record_id text NOT NULL REFERENCES settlement_payment_records(id) ON DELETE restrict,
  statement_id text NOT NULL REFERENCES settlement_statements(id) ON DELETE restrict,
  kind text NOT NULL,
  sequence integer NOT NULL,
  actor_user_id text NOT NULL REFERENCES users(id) ON DELETE restrict,
  evidence_ref text,
  state text NOT NULL,
  idempotency_key text NOT NULL,
  created_at integer NOT NULL,
  CONSTRAINT settlement_payment_event_kind_state_check CHECK (
    (kind='recorded' AND sequence=1 AND state='pending_review' AND evidence_ref IS NULL)
    OR (kind='verified' AND sequence=2 AND state='verified' AND evidence_ref IS NOT NULL)
    OR (kind='disputed' AND sequence=2 AND state='disputed' AND evidence_ref IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX settlement_payment_event_sequence_uq
  ON settlement_payment_events (payment_record_id, sequence);
--> statement-breakpoint
CREATE UNIQUE INDEX settlement_payment_event_idempotency_uq
  ON settlement_payment_events (idempotency_key);
--> statement-breakpoint
CREATE UNIQUE INDEX settlement_payment_event_terminal_uq
  ON settlement_payment_events (payment_record_id)
  WHERE kind IN ('verified','disputed');
--> statement-breakpoint
CREATE INDEX settlement_payment_event_statement_idx
  ON settlement_payment_events (statement_id, created_at);
--> statement-breakpoint
CREATE TRIGGER settlement_payment_records_no_update
BEFORE UPDATE ON settlement_payment_records
BEGIN SELECT RAISE(ABORT,'settlement payment records are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER settlement_payment_records_no_delete
BEFORE DELETE ON settlement_payment_records
BEGIN SELECT RAISE(ABORT,'settlement payment records are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER settlement_payment_records_guard
BEFORE INSERT ON settlement_payment_records
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM settlement_statements s
    JOIN settlement_parties p ON p.id=NEW.beneficiary_party_id
    WHERE s.id=NEW.statement_id
      AND s.status='locked'
      AND s.community_id=NEW.community_id
      AND p.role=NEW.beneficiary_role
      AND p.legal_name=NEW.beneficiary_legal_name
      AND p.registry_ref=NEW.beneficiary_registry_ref
      AND p.verification_ref IS NEW.beneficiary_verification_ref
      AND EXISTS (
        SELECT 1 FROM settlement_statement_lines l
        WHERE l.statement_id=s.id AND l.state='calculated'
          AND (
            (NEW.beneficiary_role='seller' AND l.seller_party_id=NEW.beneficiary_party_id)
            OR (NEW.beneficiary_role='sanchuang' AND l.sanchuang_party_id=NEW.beneficiary_party_id)
            OR (NEW.beneficiary_role='guangdian' AND l.guangdian_party_id=NEW.beneficiary_party_id)
          )
      )
  ) THEN RAISE(ABORT,'settlement payment beneficiary does not match locked statement') END;
  SELECT CASE WHEN
    NEW.amount_cents + COALESCE((
      SELECT SUM(r.amount_cents)
      FROM settlement_payment_records r
      WHERE r.statement_id=NEW.statement_id
        AND r.beneficiary_party_id=NEW.beneficiary_party_id
    ),0) > NEW.payable_cents_snapshot
  THEN RAISE(ABORT,'settlement payment overpay is forbidden') END;
END;
--> statement-breakpoint
CREATE TRIGGER settlement_payment_events_no_update
BEFORE UPDATE ON settlement_payment_events
BEGIN SELECT RAISE(ABORT,'settlement payment events are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER settlement_payment_events_no_delete
BEFORE DELETE ON settlement_payment_events
BEGIN SELECT RAISE(ABORT,'settlement payment events are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER settlement_payment_events_guard
BEFORE INSERT ON settlement_payment_events
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM settlement_payment_records r
    WHERE r.id=NEW.payment_record_id AND r.statement_id=NEW.statement_id
  ) THEN RAISE(ABORT,'payment event does not match payment record') END;
  SELECT CASE WHEN NEW.kind='recorded' AND NOT EXISTS (
    SELECT 1 FROM settlement_payment_records r
    WHERE r.id=NEW.payment_record_id AND r.recorder_user_id=NEW.actor_user_id
  ) THEN RAISE(ABORT,'recorded event actor must be recorder') END;
  SELECT CASE WHEN NEW.kind IN ('verified','disputed') AND (
    NOT EXISTS (
      SELECT 1 FROM settlement_payment_events e
      WHERE e.payment_record_id=NEW.payment_record_id
        AND e.kind='recorded' AND e.sequence=1
    )
    OR EXISTS (
      SELECT 1 FROM settlement_payment_records r
      WHERE r.id=NEW.payment_record_id AND r.recorder_user_id=NEW.actor_user_id
    )
  ) THEN RAISE(ABORT,'payment review requires a different authenticated recorder/reviewer') END;
END;
