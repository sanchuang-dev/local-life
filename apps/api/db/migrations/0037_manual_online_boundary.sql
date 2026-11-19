-- R1/R2 boundary repair: two order-level conflict kinds are added to the PAY-05
-- manual-review queue, so the same durable table keeps carrying every case where
-- money and order state disagree:
--
--   * `manual_online_double_collection` — a trusted channel payment arrived for an
--     order that already has a manual receipt. The online money fact is preserved
--     for a human; no completion, second ledger receipt or reward grant is created.
--   * `consumer_exhausted` — the PAY-05 completion chain exhausted its retry
--     budget and parked the outbox row. The order stays uncompleted but the
--     anomaly is now visible (order/intent/outbox/channel reference/amount/reason)
--     and can be replayed through the internal token-gated recovery endpoint.
--
-- SQLite cannot extend a CHECK constraint in place, so the table is rebuilt with
-- its previous columns, foreign keys, indexes and triggers copied verbatim and
-- its rows copied unchanged. Foreign-key enforcement is disabled by
-- `createDatabase` around the whole migration run and re-checked before the
-- connection is handed out, which is the documented SQLite rebuild procedure.
--
-- No row of any other table is touched; the existing evidence columns
-- (`dedupe_key`, `kind`, `detail`, ids, `created_at`) stay immutable through the
-- same triggers, so a recovery can only move `status` to `resolved`.
PRAGMA legacy_alter_table=ON;
--> statement-breakpoint
CREATE TABLE `local_order_online_conflicts_new` (
	`id` text PRIMARY KEY NOT NULL,
	`local_order_id` text NOT NULL,
	`payment_intent_id` text,
	`payment_outbox_id` text,
	`dedupe_key` text NOT NULL,
	`kind` text NOT NULL,
	`detail` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`local_order_id`) REFERENCES `local_orders`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`payment_intent_id`) REFERENCES `payment_intents`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`payment_outbox_id`) REFERENCES `payment_outbox`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "local_order_online_conflicts_kind_check" CHECK(`kind` IN ('order_not_payable', 'order_already_completed',
        'payment_state_invalid', 'coupon_state_invalid', 'late_success',
        'manual_online_double_collection', 'consumer_exhausted')),
	CONSTRAINT "local_order_online_conflicts_status_check" CHECK(`status` IN ('open', 'reviewed', 'resolved')),
	CONSTRAINT "local_order_online_conflicts_detail_check" CHECK(length(trim(`detail`)) BETWEEN 1 AND 500),
	CONSTRAINT "local_order_online_conflicts_resolved_check" CHECK(((`status` = 'resolved') = (`resolved_at` IS NOT NULL)))
);
--> statement-breakpoint
INSERT INTO `local_order_online_conflicts_new`
  (`id`, `local_order_id`, `payment_intent_id`, `payment_outbox_id`, `dedupe_key`,
   `kind`, `detail`, `status`, `created_at`, `resolved_at`)
SELECT
  `id`, `local_order_id`, `payment_intent_id`, `payment_outbox_id`, `dedupe_key`,
  `kind`, `detail`, `status`, `created_at`, `resolved_at`
FROM `local_order_online_conflicts`;
--> statement-breakpoint
DROP TABLE `local_order_online_conflicts`;
--> statement-breakpoint
ALTER TABLE `local_order_online_conflicts_new` RENAME TO `local_order_online_conflicts`;
--> statement-breakpoint
CREATE UNIQUE INDEX `local_order_online_conflicts_dedupe_uq` ON `local_order_online_conflicts` (`dedupe_key`);
--> statement-breakpoint
CREATE INDEX `local_order_online_conflicts_order_created_idx` ON `local_order_online_conflicts` (`local_order_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `local_order_online_conflicts_status_created_idx` ON `local_order_online_conflicts` (`status`,`created_at`);
--> statement-breakpoint
CREATE TRIGGER `local_order_online_conflicts_no_delete`
BEFORE DELETE ON `local_order_online_conflicts`
BEGIN
  SELECT RAISE(ABORT, 'online conflict records are durable history');
END;
--> statement-breakpoint
CREATE TRIGGER `local_order_online_conflicts_immutable_evidence`
BEFORE UPDATE ON `local_order_online_conflicts`
WHEN OLD.`id` IS NOT NEW.`id`
  OR OLD.`local_order_id` IS NOT NEW.`local_order_id`
  OR OLD.`payment_intent_id` IS NOT NEW.`payment_intent_id`
  OR OLD.`payment_outbox_id` IS NOT NEW.`payment_outbox_id`
  OR OLD.`dedupe_key` IS NOT NEW.`dedupe_key`
  OR OLD.`kind` IS NOT NEW.`kind`
  OR OLD.`detail` IS NOT NEW.`detail`
  OR OLD.`created_at` IS NOT NEW.`created_at`
BEGIN
  SELECT RAISE(ABORT, 'online conflict evidence is immutable');
END;
--> statement-breakpoint
-- Restore the default rename behaviour for later migrations on this connection.
PRAGMA legacy_alter_table=OFF;
