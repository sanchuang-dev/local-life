CREATE TABLE settlement_rule_versions (
  id text PRIMARY KEY NOT NULL,
  mapping_id text NOT NULL REFERENCES settlement_product_mappings(id) ON DELETE restrict,
  version integer NOT NULL,
  community_id text NOT NULL REFERENCES communities(id) ON DELETE restrict,
  product_id text NOT NULL REFERENCES local_products(id) ON DELETE restrict,
  seller_party_id text NOT NULL REFERENCES settlement_parties(id) ON DELETE restrict,
  sanchuang_party_id text NOT NULL REFERENCES settlement_parties(id) ON DELETE restrict,
  guangdian_party_id text NOT NULL REFERENCES settlement_parties(id) ON DELETE restrict,
  agreement_ref text NOT NULL,
  approval_evidence_ref text NOT NULL,
  approval_on text NOT NULL,
  effective_from text NOT NULL,
  effective_to text NOT NULL,
  fee_base text NOT NULL,
  processor_fee_bps integer NOT NULL,
  processor_fee_owner text NOT NULL,
  seller_rate_bps integer NOT NULL,
  sanchuang_rate_bps integer NOT NULL,
  guangdian_rate_bps integer NOT NULL,
  rounding_recipient text NOT NULL,
  rounding_policy text NOT NULL,
  processor_fee_rounding text NOT NULL,
  reversal_policy text NOT NULL,
  partial_refund_policy text NOT NULL,
  approval_status text NOT NULL,
  approved_by_user_id text NOT NULL REFERENCES users(id) ON DELETE restrict,
  approved_at integer NOT NULL,
  CONSTRAINT settlement_rule_version_positive CHECK (version >= 1),
  CONSTRAINT settlement_rule_dates_check CHECK (approval_on <= effective_from AND effective_from <= effective_to),
  CONSTRAINT settlement_rule_rate_sum_check CHECK (
    seller_rate_bps >= 0 AND sanchuang_rate_bps >= 0 AND guangdian_rate_bps >= 0
    AND seller_rate_bps + sanchuang_rate_bps + guangdian_rate_bps = 10000
  ),
  CONSTRAINT settlement_rule_fee_check CHECK (
    processor_fee_bps BETWEEN 0 AND 10000
    AND ((processor_fee_bps=0 AND processor_fee_owner='none')
      OR (processor_fee_bps > 0 AND processor_fee_owner IN ('seller','sanchuang','guangdian')))
  ),
  CONSTRAINT settlement_rule_terms_check CHECK (
    fee_base='actual_received'
    AND rounding_recipient IN ('seller','sanchuang','guangdian')
    AND rounding_policy='floor_then_named_remainder'
    AND processor_fee_rounding='floor'
    AND reversal_policy='full_reversal_blocks'
    AND partial_refund_policy='unsupported_blocks'
    AND approval_status='admin_attested'
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX settlement_rule_mapping_version_uq ON settlement_rule_versions (mapping_id, version);
--> statement-breakpoint
CREATE UNIQUE INDEX settlement_rule_mapping_approval_uq ON settlement_rule_versions (mapping_id, approval_evidence_ref);
--> statement-breakpoint
CREATE INDEX settlement_rule_period_idx ON settlement_rule_versions (community_id, product_id, effective_from, effective_to);
--> statement-breakpoint
CREATE TRIGGER settlement_rule_guard BEFORE INSERT ON settlement_rule_versions
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM settlement_product_mappings m
    JOIN settlement_parties s ON s.id=m.seller_party_id AND s.role='seller' AND s.verified_at IS NOT NULL
    JOIN settlement_parties t ON t.id=m.sanchuang_party_id AND t.role='sanchuang' AND t.verified_at IS NOT NULL
    JOIN settlement_parties g ON g.id=m.guangdian_party_id AND g.role='guangdian' AND g.verified_at IS NOT NULL
    WHERE m.id=NEW.mapping_id
      AND m.community_id=NEW.community_id AND m.product_id=NEW.product_id
      AND m.seller_party_id=NEW.seller_party_id
      AND m.sanchuang_party_id=NEW.sanchuang_party_id
      AND m.guangdian_party_id=NEW.guangdian_party_id
      AND m.agreement_ref=NEW.agreement_ref
      AND NEW.effective_from>=m.effective_from AND NEW.effective_to<=m.effective_to
  ) THEN RAISE(ABORT,'approved rule must match verified mapped parties and dates') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM settlement_rule_versions v
    WHERE v.mapping_id=NEW.mapping_id
      AND v.effective_from<=NEW.effective_to
      AND v.effective_to>=NEW.effective_from
  ) THEN RAISE(ABORT,'overlapping approved settlement rule') END;
END;
--> statement-breakpoint
CREATE TRIGGER settlement_rule_no_update BEFORE UPDATE ON settlement_rule_versions
BEGIN SELECT RAISE(ABORT,'settlement rules are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER settlement_rule_no_delete BEFORE DELETE ON settlement_rule_versions
BEGIN SELECT RAISE(ABORT,'settlement rules are immutable'); END;
