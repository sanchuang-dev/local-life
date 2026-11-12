-- LL-PUR-008 (#213): retain terminal order history while allowing a valid
-- unspent coupon to be re-used ONLY after the original unpaid order ends.
-- A permanent unique coupon_id would falsely prevent any recovery.
DROP INDEX `local_orders_coupon_uq`;--> statement-breakpoint
CREATE UNIQUE INDEX `local_orders_active_coupon_uq` ON `local_orders`(`coupon_id`)
  WHERE `coupon_id` IS NOT NULL AND `status` NOT IN ('cancelled','rejected');--> statement-breakpoint
-- One durable, unique dispute per invalidated grant or reversed redeemed use.
-- Monetary and receipt facts are never updated/deleted.
CREATE TABLE `coupon_reward_disputes` (
  `id` text PRIMARY KEY NOT NULL,
  `dispute_key` text NOT NULL,
  `kind` text NOT NULL CHECK (`kind` IN ('reward_eligibility_lost','redeemed_payment_reversed')),
  `grant_id` text NOT NULL REFERENCES `coupon_team_grants`(`id`) ON DELETE RESTRICT,
  `coupon_id` text REFERENCES `coupon_issues`(`id`) ON DELETE RESTRICT,
  `source_order_id` text NOT NULL REFERENCES `local_orders`(`id`) ON DELETE RESTRICT,
  `reversal_entry_id` text NOT NULL REFERENCES `ledger_entries`(`id`) ON DELETE RESTRICT,
  `resolution` text NOT NULL CHECK (`resolution` IN ('auto_void','pending_manual')),
  `created_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `coupon_reward_disputes_key_uq` ON `coupon_reward_disputes`(`dispute_key`);--> statement-breakpoint
CREATE INDEX `coupon_reward_disputes_grant_idx` ON `coupon_reward_disputes`(`grant_id`);--> statement-breakpoint
CREATE INDEX `coupon_reward_disputes_reversal_idx` ON `coupon_reward_disputes`(`reversal_entry_id`);--> statement-breakpoint
CREATE TRIGGER `coupon_reward_disputes_no_update` BEFORE UPDATE ON `coupon_reward_disputes`
BEGIN SELECT RAISE(ABORT,'coupon disputes are append only'); END;--> statement-breakpoint
CREATE TRIGGER `coupon_reward_disputes_no_delete` BEFORE DELETE ON `coupon_reward_disputes`
BEGIN SELECT RAISE(ABORT,'coupon disputes are append only'); END;--> statement-breakpoint
-- A released coupon must come from a terminal, unpaid order. Historical
-- order/coupon identity remains unchanged, but the active reservation is freed.
CREATE TRIGGER `coupon_issues_release_guard` BEFORE UPDATE ON `coupon_issues`
WHEN OLD.status='reserved' AND NEW.status='available'
BEGIN
  SELECT RAISE(ABORT,'coupon release requires unpaid terminal order')
  WHERE NEW.reserved_order_id IS NOT NULL OR NEW.reserved_at IS NOT NULL
    OR NEW.redeemed_at IS NOT NULL
    OR NOT EXISTS (
      SELECT 1 FROM `local_orders` o WHERE o.id=OLD.reserved_order_id
        AND o.status IN ('cancelled','rejected')
    )
    OR EXISTS (SELECT 1 FROM `ledger_payment_order_links` l WHERE l.order_id=OLD.reserved_order_id)
    OR EXISTS (SELECT 1 FROM `coupon_reward_disputes` d
      WHERE d.grant_id=OLD.grant_id AND d.kind='reward_eligibility_lost');
END;--> statement-breakpoint
-- Once a reward has been revoked, it cannot be reactivated by another writer.
CREATE TRIGGER `coupon_issues_void_guard` BEFORE UPDATE ON `coupon_issues`
WHEN NEW.status='void' AND OLD.status<>'void'
BEGIN
  SELECT RAISE(ABORT,'coupon void requires source reward dispute')
  WHERE NEW.voided_at IS NULL OR OLD.status='redeemed'
    OR NOT EXISTS (SELECT 1 FROM `coupon_reward_disputes` d
      WHERE d.grant_id=OLD.grant_id AND d.kind='reward_eligibility_lost');
END;--> statement-breakpoint
CREATE TRIGGER `coupon_issues_terminal_guard` BEFORE UPDATE ON `coupon_issues`
WHEN OLD.status IN ('redeemed','void') AND NEW.status<>OLD.status
BEGIN SELECT RAISE(ABORT,'redeemed or void coupon cannot be restored'); END;--> statement-breakpoint
-- An available coupon must belong to a currently valid grant. Reversals never
-- mint replacement liability; manual reconciliation is a separate explicit act.
CREATE TRIGGER `coupon_issues_no_reclaim_disputed` BEFORE UPDATE ON `coupon_issues`
WHEN NEW.status IN ('available','reserved') AND OLD.status<>NEW.status
BEGIN
  SELECT RAISE(ABORT,'disputed grant cannot be reused')
  WHERE EXISTS (SELECT 1 FROM `coupon_reward_disputes` d
    WHERE d.grant_id=OLD.grant_id AND d.kind='reward_eligibility_lost');
END;
