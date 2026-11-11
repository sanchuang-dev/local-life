CREATE TABLE settlement_statements (
  id text PRIMARY KEY NOT NULL,
  statement_no text NOT NULL,
  community_id text NOT NULL REFERENCES communities(id) ON DELETE restrict,
  period_from text NOT NULL,
  period_to text NOT NULL,
  generation integer NOT NULL,
  revision integer NOT NULL,
  status text NOT NULL,
  snapshot_digest text NOT NULL,
  as_of integer NOT NULL,
  line_count integer NOT NULL,
  calculated_count integer NOT NULL,
  blocked_count integer NOT NULL,
  eligible_gross_cents integer NOT NULL,
  fee_cents integer NOT NULL,
  seller_net_cents integer NOT NULL,
  sanchuang_net_cents integer NOT NULL,
  guangdian_net_cents integer NOT NULL,
  created_by_user_id text NOT NULL REFERENCES users(id) ON DELETE restrict,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  reviewed_by_user_id text REFERENCES users(id) ON DELETE restrict,
  review_evidence_ref text,
  reviewed_at integer,
  locked_by_user_id text REFERENCES users(id) ON DELETE restrict,
  lock_evidence_ref text,
  locked_at integer,
  CONSTRAINT settlement_statements_status_check CHECK (status IN ('draft','reviewed','locked','superseded')),
  CONSTRAINT settlement_statements_money_check CHECK (
    line_count >= 0 AND calculated_count >= 0 AND blocked_count >= 0
    AND line_count = calculated_count + blocked_count
    AND eligible_gross_cents >= 0 AND fee_cents >= 0
    AND seller_net_cents >= 0 AND sanchuang_net_cents >= 0 AND guangdian_net_cents >= 0
    AND eligible_gross_cents = fee_cents + seller_net_cents + sanchuang_net_cents + guangdian_net_cents
  ),
  CONSTRAINT settlement_statements_review_check CHECK (
    (status = 'draft' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL AND locked_at IS NULL)
    OR (status IN ('reviewed','locked') AND reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL
      AND review_evidence_ref IS NOT NULL AND reviewed_by_user_id <> created_by_user_id
      AND ((status = 'reviewed' AND locked_at IS NULL)
        OR (status = 'locked' AND locked_at IS NOT NULL
          AND locked_by_user_id IS NOT NULL AND lock_evidence_ref IS NOT NULL)))
    OR (status = 'superseded' AND locked_at IS NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX settlement_statements_no_uq ON settlement_statements (statement_no);
--> statement-breakpoint
CREATE UNIQUE INDEX settlement_statements_period_generation_uq ON settlement_statements (community_id, period_from, period_to, generation);
--> statement-breakpoint
CREATE UNIQUE INDEX settlement_statements_active_period_uq ON settlement_statements (community_id, period_from, period_to) WHERE status <> 'superseded';
--> statement-breakpoint
CREATE INDEX settlement_statements_scope_idx ON settlement_statements (community_id, created_at);
--> statement-breakpoint
CREATE TABLE settlement_statement_lines (
  id text PRIMARY KEY NOT NULL,
  statement_id text NOT NULL REFERENCES settlement_statements(id) ON DELETE restrict,
  order_id text NOT NULL REFERENCES local_orders(id) ON DELETE restrict,
  order_display_no text NOT NULL,
  community_id text NOT NULL REFERENCES communities(id) ON DELETE restrict,
  product_id text NOT NULL REFERENCES local_products(id) ON DELETE restrict,
  product_name text NOT NULL,
  period_at integer NOT NULL,
  registered_amount_cents integer NOT NULL,
  receipt_entry_id text REFERENCES ledger_entries(id) ON DELETE restrict,
  receipt_evidence_ref text,
  receipt_received_at integer,
  receipt_amount_cents integer,
  operating_batch_id text REFERENCES reconciliation_batches(id) ON DELETE restrict,
  grid_staff_id text REFERENCES staff_accounts(id) ON DELETE restrict,
  grid_reviewer_user_id text REFERENCES users(id) ON DELETE restrict,
  mapping_id text REFERENCES settlement_product_mappings(id) ON DELETE restrict,
  seller_party_id text REFERENCES settlement_parties(id) ON DELETE restrict,
  sanchuang_party_id text REFERENCES settlement_parties(id) ON DELETE restrict,
  guangdian_party_id text REFERENCES settlement_parties(id) ON DELETE restrict,
  agreement_ref text,
  rule_id text REFERENCES settlement_rule_versions(id) ON DELETE restrict,
  rule_version integer,
  state text NOT NULL,
  blocking_reasons_json text NOT NULL,
  allocation_json text,
  source_digest text NOT NULL,
  CONSTRAINT settlement_statement_line_state_check CHECK (
    (state = 'blocked' AND allocation_json IS NULL)
    OR (state = 'calculated' AND allocation_json IS NOT NULL
      AND rule_id IS NOT NULL AND receipt_entry_id IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX settlement_statement_line_order_uq ON settlement_statement_lines (statement_id, order_id);
--> statement-breakpoint
CREATE INDEX settlement_statement_line_receipt_idx ON settlement_statement_lines (receipt_entry_id);
--> statement-breakpoint
CREATE INDEX settlement_statement_line_grid_idx ON settlement_statement_lines (statement_id, grid_staff_id);
--> statement-breakpoint
CREATE TABLE settlement_statement_events (
  id text PRIMARY KEY NOT NULL,
  statement_id text NOT NULL REFERENCES settlement_statements(id) ON DELETE restrict,
  kind text NOT NULL,
  revision integer NOT NULL,
  actor_user_id text NOT NULL REFERENCES users(id) ON DELETE restrict,
  evidence_ref text,
  snapshot_digest text NOT NULL,
  created_at integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX settlement_statement_event_revision_uq ON settlement_statement_events (statement_id, revision);
--> statement-breakpoint
CREATE TABLE settlement_receipt_claims (
  receipt_entry_id text PRIMARY KEY NOT NULL REFERENCES ledger_entries(id) ON DELETE restrict,
  order_id text NOT NULL REFERENCES local_orders(id) ON DELETE restrict,
  statement_id text NOT NULL REFERENCES settlement_statements(id) ON DELETE restrict,
  line_id text NOT NULL REFERENCES settlement_statement_lines(id) ON DELETE restrict,
  claimed_at integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX settlement_receipt_claim_order_uq ON settlement_receipt_claims (order_id);
--> statement-breakpoint
CREATE UNIQUE INDEX settlement_receipt_claim_line_uq ON settlement_receipt_claims (line_id);
--> statement-breakpoint
CREATE INDEX settlement_receipt_claim_statement_idx ON settlement_receipt_claims (statement_id);
--> statement-breakpoint
CREATE TRIGGER settlement_statements_no_delete BEFORE DELETE ON settlement_statements
BEGIN SELECT RAISE(ABORT, 'settlement statements cannot be deleted'); END;
--> statement-breakpoint
CREATE TRIGGER settlement_statements_guard BEFORE UPDATE ON settlement_statements
BEGIN
  SELECT CASE WHEN
    OLD.status = 'locked' OR OLD.status = 'superseded' OR
    NEW.revision <> OLD.revision + 1 OR NEW.updated_at <= OLD.updated_at OR
    NOT ((OLD.status = 'draft' AND NEW.status IN ('reviewed','superseded'))
      OR (OLD.status = 'reviewed' AND NEW.status IN ('locked','superseded'))) OR
    NEW.id IS NOT OLD.id OR NEW.statement_no IS NOT OLD.statement_no OR
    NEW.community_id IS NOT OLD.community_id OR
    NEW.period_from IS NOT OLD.period_from OR NEW.period_to IS NOT OLD.period_to OR
    NEW.generation IS NOT OLD.generation OR NEW.snapshot_digest IS NOT OLD.snapshot_digest OR
    NEW.as_of IS NOT OLD.as_of OR NEW.line_count IS NOT OLD.line_count OR
    NEW.calculated_count IS NOT OLD.calculated_count OR NEW.blocked_count IS NOT OLD.blocked_count OR
    NEW.eligible_gross_cents IS NOT OLD.eligible_gross_cents OR
    NEW.fee_cents IS NOT OLD.fee_cents OR NEW.seller_net_cents IS NOT OLD.seller_net_cents OR
    NEW.sanchuang_net_cents IS NOT OLD.sanchuang_net_cents OR
    NEW.guangdian_net_cents IS NOT OLD.guangdian_net_cents OR
    NEW.created_by_user_id IS NOT OLD.created_by_user_id OR NEW.created_at IS NOT OLD.created_at
  THEN RAISE(ABORT,'settlement snapshot or state transition is immutable') END;
END;
--> statement-breakpoint
CREATE TRIGGER settlement_statement_lines_no_update BEFORE UPDATE ON settlement_statement_lines
BEGIN SELECT RAISE(ABORT,'settlement line snapshots are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER settlement_statement_lines_no_delete BEFORE DELETE ON settlement_statement_lines
BEGIN SELECT RAISE(ABORT,'settlement line snapshots are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER settlement_statement_lines_guard BEFORE INSERT ON settlement_statement_lines
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM settlement_statements s WHERE s.id=NEW.statement_id
      AND s.status='draft' AND s.community_id=NEW.community_id
  ) THEN RAISE(ABORT,'statement line not in originating draft community') END;
END;
--> statement-breakpoint
CREATE TRIGGER settlement_statement_events_no_update BEFORE UPDATE ON settlement_statement_events
BEGIN SELECT RAISE(ABORT,'settlement audit events are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER settlement_statement_events_no_delete BEFORE DELETE ON settlement_statement_events
BEGIN SELECT RAISE(ABORT,'settlement audit events are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER settlement_receipt_claims_no_update BEFORE UPDATE ON settlement_receipt_claims
BEGIN SELECT RAISE(ABORT,'settlement receipt claims are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER settlement_receipt_claims_no_delete BEFORE DELETE ON settlement_receipt_claims
BEGIN SELECT RAISE(ABORT,'settlement receipt claims are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER settlement_receipt_claims_guard BEFORE INSERT ON settlement_receipt_claims
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM settlement_statements s JOIN settlement_statement_lines l
      ON l.statement_id=s.id WHERE s.id=NEW.statement_id AND s.status='locked'
      AND l.id=NEW.line_id AND l.order_id=NEW.order_id
      AND l.receipt_entry_id=NEW.receipt_entry_id AND l.state='calculated'
  ) THEN RAISE(ABORT,'receipt claim not in locked priced statement') END;
END;
