CREATE TABLE settlement_parties (
  id text PRIMARY KEY NOT NULL,
  role text NOT NULL,
  legal_name text NOT NULL,
  registry_ref text NOT NULL,
  verification_ref text,
  verified_at integer,
  created_by_user_id text NOT NULL REFERENCES users(id) ON DELETE restrict,
  created_at integer NOT NULL,
  CONSTRAINT settlement_parties_role_check CHECK (role IN ('seller','sanchuang','guangdian')),
  CONSTRAINT settlement_parties_verification_check CHECK (
    (verified_at IS NULL AND verification_ref IS NULL) OR
    (verified_at IS NOT NULL AND verification_ref IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX settlement_parties_role_registry_idx ON settlement_parties (role, registry_ref);
--> statement-breakpoint
CREATE UNIQUE INDEX settlement_parties_verified_version_uq ON settlement_parties (role, registry_ref, verification_ref) WHERE verification_ref IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX settlement_parties_pending_version_uq ON settlement_parties (role, registry_ref) WHERE verification_ref IS NULL;
--> statement-breakpoint
CREATE TABLE settlement_product_mappings (
  id text PRIMARY KEY NOT NULL,
  community_id text NOT NULL REFERENCES communities(id) ON DELETE restrict,
  product_id text NOT NULL REFERENCES local_products(id) ON DELETE restrict,
  seller_party_id text NOT NULL REFERENCES settlement_parties(id) ON DELETE restrict,
  sanchuang_party_id text REFERENCES settlement_parties(id) ON DELETE restrict,
  guangdian_party_id text REFERENCES settlement_parties(id) ON DELETE restrict,
  agreement_ref text NOT NULL,
  effective_from text NOT NULL,
  effective_to text NOT NULL,
  created_by_user_id text NOT NULL REFERENCES users(id) ON DELETE restrict,
  created_at integer NOT NULL,
  CONSTRAINT settlement_mapping_period_check CHECK (effective_from <= effective_to)
);
--> statement-breakpoint
CREATE INDEX settlement_mapping_community_product_idx ON settlement_product_mappings (community_id, product_id);
--> statement-breakpoint
CREATE INDEX settlement_mapping_seller_idx ON settlement_product_mappings (seller_party_id);
--> statement-breakpoint
CREATE TABLE settlement_order_party_snapshots (
  order_id text PRIMARY KEY NOT NULL REFERENCES local_orders(id) ON DELETE restrict,
  mapping_id text NOT NULL REFERENCES settlement_product_mappings(id) ON DELETE restrict,
  seller_party_id text NOT NULL REFERENCES settlement_parties(id) ON DELETE restrict,
  sanchuang_party_id text REFERENCES settlement_parties(id) ON DELETE restrict,
  guangdian_party_id text REFERENCES settlement_parties(id) ON DELETE restrict,
  agreement_ref text NOT NULL,
  confirmation_ref text NOT NULL,
  confirmed_by_user_id text NOT NULL REFERENCES users(id) ON DELETE restrict,
  confirmed_at integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX settlement_order_party_mapping_idx ON settlement_order_party_snapshots (mapping_id);
--> statement-breakpoint
CREATE TRIGGER settlement_parties_no_update BEFORE UPDATE ON settlement_parties
BEGIN SELECT RAISE(ABORT, 'settlement party versions are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER settlement_parties_no_delete BEFORE DELETE ON settlement_parties
BEGIN SELECT RAISE(ABORT, 'settlement party versions are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER settlement_mapping_guard BEFORE INSERT ON settlement_product_mappings
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM local_products p WHERE p.id=NEW.product_id AND p.community_id=NEW.community_id
  ) THEN RAISE(ABORT, 'seller mapping community mismatch') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM settlement_parties p WHERE p.id=NEW.seller_party_id AND p.role='seller' AND p.verified_at IS NOT NULL
  ) THEN RAISE(ABORT, 'seller must be verified') END;
  SELECT CASE WHEN NEW.sanchuang_party_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM settlement_parties p WHERE p.id=NEW.sanchuang_party_id AND p.role='sanchuang' AND p.verified_at IS NOT NULL
  ) THEN RAISE(ABORT, 'Sanchuang entity must be verified') END;
  SELECT CASE WHEN NEW.guangdian_party_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM settlement_parties p WHERE p.id=NEW.guangdian_party_id AND p.role='guangdian' AND p.verified_at IS NOT NULL
  ) THEN RAISE(ABORT, 'Guangdian entity must be verified') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM settlement_product_mappings m WHERE m.product_id=NEW.product_id
      AND m.effective_from <= NEW.effective_to AND m.effective_to >= NEW.effective_from
  ) THEN RAISE(ABORT, 'overlapping seller mapping dates') END;
END;
--> statement-breakpoint
CREATE TRIGGER settlement_mapping_no_update BEFORE UPDATE ON settlement_product_mappings
BEGIN SELECT RAISE(ABORT, 'seller mapping versions are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER settlement_mapping_no_delete BEFORE DELETE ON settlement_product_mappings
BEGIN SELECT RAISE(ABORT, 'seller mapping versions are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER settlement_order_party_guard BEFORE INSERT ON settlement_order_party_snapshots
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM local_orders o JOIN settlement_product_mappings m
      ON m.id=NEW.mapping_id AND m.product_id=o.product_id AND m.community_id=o.community_id
    WHERE o.id=NEW.order_id AND o.status='verified'
      AND date(o.created_at / 1000, 'unixepoch', '+8 hours') BETWEEN m.effective_from AND m.effective_to
      AND NEW.seller_party_id=m.seller_party_id
      AND NEW.sanchuang_party_id IS m.sanchuang_party_id
      AND NEW.guangdian_party_id IS m.guangdian_party_id
      AND NEW.agreement_ref=m.agreement_ref
  ) THEN RAISE(ABORT, 'order mapping is not verified or not effective') END;
END;
--> statement-breakpoint
CREATE TRIGGER settlement_order_party_no_update BEFORE UPDATE ON settlement_order_party_snapshots
BEGIN SELECT RAISE(ABORT, 'order party snapshots are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER settlement_order_party_no_delete BEFORE DELETE ON settlement_order_party_snapshots
BEGIN SELECT RAISE(ABORT, 'order party snapshots are immutable'); END;
