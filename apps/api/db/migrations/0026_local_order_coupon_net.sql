-- #212 LL-PUR-007: single-coupon whole-value discount, immutable order cents.
-- Keep total_cents as the historical product gross. All existing rows are no-coupon
-- (discount=0); no ledger facts or locked statements are rewritten.
ALTER TABLE `local_orders` ADD COLUMN `coupon_discount_cents` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `local_orders` ADD COLUMN `coupon_id` text REFERENCES `coupon_issues`(`id`) ON DELETE RESTRICT;--> statement-breakpoint
CREATE UNIQUE INDEX `local_orders_coupon_uq` ON `local_orders`(`coupon_id`);--> statement-breakpoint
-- Already locked settlement snapshots retain NULL and are rendered as gross-only.
ALTER TABLE `settlement_statement_lines` ADD COLUMN `coupon_discount_cents` integer;--> statement-breakpoint
ALTER TABLE `settlement_statement_lines` ADD COLUMN `net_payable_cents` integer;--> statement-breakpoint
CREATE TRIGGER `local_orders_coupon_insert_check` BEFORE INSERT ON `local_orders`
BEGIN
  SELECT RAISE(ABORT,'invalid coupon order amount')
  WHERE NEW.coupon_discount_cents < 0 OR NEW.coupon_discount_cents > NEW.total_cents
    OR (NEW.coupon_id IS NULL AND NEW.coupon_discount_cents <> 0)
    OR (NEW.coupon_id IS NOT NULL AND NEW.coupon_discount_cents <= 0);
  SELECT RAISE(ABORT,'coupon not available to this buyer and community')
  WHERE NEW.coupon_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM `coupon_issues` c
    JOIN `activities` a ON a.id=c.activity_id
    WHERE c.id=NEW.coupon_id AND c.user_id=NEW.resident_user_id
      AND c.status='available' AND c.expires_at>NEW.created_at
      AND c.face_value_cents=NEW.coupon_discount_cents
      AND a.community_id=NEW.community_id
  );
END;--> statement-breakpoint
CREATE TRIGGER `local_orders_coupon_immutable` BEFORE UPDATE ON `local_orders`
WHEN OLD.coupon_id IS NOT NEW.coupon_id
  OR OLD.coupon_discount_cents IS NOT NEW.coupon_discount_cents
  OR OLD.total_cents IS NOT NEW.total_cents
  OR OLD.unit_price_cents IS NOT NEW.unit_price_cents
  OR OLD.quantity IS NOT NEW.quantity
BEGIN SELECT RAISE(ABORT,'order price and coupon snapshot are immutable'); END;--> statement-breakpoint
-- Prohibit a second writer from reserving/consuming a coupon for the wrong order.
CREATE TRIGGER `coupon_issues_order_link_check` BEFORE UPDATE ON `coupon_issues`
WHEN NEW.status IN ('reserved','redeemed')
BEGIN
  SELECT RAISE(ABORT,'invalid coupon status transition')
  WHERE NOT ((OLD.status='available' AND NEW.status='reserved')
          OR (OLD.status='reserved' AND NEW.status='redeemed'));
  SELECT RAISE(ABORT,'coupon reserved for mismatched order')
  WHERE NOT EXISTS (
    SELECT 1 FROM `local_orders` o
    WHERE o.id=NEW.reserved_order_id AND o.coupon_id=NEW.id
      AND o.resident_user_id=NEW.user_id AND o.coupon_discount_cents=NEW.face_value_cents
      AND o.total_cents>=NEW.face_value_cents
  );
END;--> statement-breakpoint
-- The one-to-one receipt link for a *coupon order* is always for net cash,
-- never gross. Legacy no-coupon mismatched proof stays auditable but blocked.
CREATE TRIGGER `ledger_payment_order_links_coupon_net_check`
BEFORE INSERT ON `ledger_payment_order_links`
WHEN (SELECT coupon_id FROM `local_orders` WHERE id=NEW.order_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'coupon order receipt must equal net payable')
  WHERE NOT EXISTS (
    SELECT 1 FROM `local_orders` o
    JOIN `ledger_entries` e ON e.id=NEW.entry_id
    WHERE o.id=NEW.order_id AND e.fact_kind='payment_received'
      AND e.amount_cents=(o.total_cents-o.coupon_discount_cents)
      AND e.amount_cents>0
  );
END;
