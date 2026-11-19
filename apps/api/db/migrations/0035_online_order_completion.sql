-- PAY-05 (#280): online order completion, zero-amount coupon orders, coupon release.
--
-- Two existing CHECK constraints must gain one new value, which SQLite cannot do
-- in place, so `local_orders` and `local_order_events` are rebuilt with their
-- previous shape (all indexes and triggers are recreated verbatim below):
--
--   * `local_orders.status`      gains 'online_completed' — a trusted online
--     payment fact, deliberately distinct from the manual 'verified' fact.
--   * `local_order_events.event` gains 'order.online_completed'.
--
-- Foreign-key enforcement is disabled by `createDatabase` around the whole
-- migration run and re-verified with `PRAGMA foreign_key_check` before the
-- connection is handed out: replacing a table that child rows reference is the
-- documented SQLite rebuild procedure. Rows are copied unchanged; no historical
-- order, receipt or settlement fact is rewritten.
--
-- Two new append-only tables hold the PAY-05 projection:
--   * `local_order_online_completions` — exactly one immutable completion per
--     order and per payment intent (idempotency authority), with no cash for the
--     coupon-only path;
--   * `local_order_online_conflicts`    — durable manual-review records for a
--     trusted payment that could not be projected onto its order.
--
-- No rollback statement: the drizzle better-sqlite3 migrator applies a file
-- inside one transaction, so a failure leaves the database at 0034 intact.
-- Existing triggers on *other* tables mention `local_orders`; during the rename
-- below the old table no longer exists, and SQLite's modern RENAME re-parses (and
-- therefore fails on) those triggers. Legacy rename only swaps the name, which is
-- exactly what a same-shape rebuild needs.
PRAGMA legacy_alter_table=ON;
--> statement-breakpoint
CREATE TABLE `local_orders_new` (
	`id` text PRIMARY KEY NOT NULL,
	`community_id` text NOT NULL,
	`product_id` text NOT NULL,
	`resident_user_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`status` text NOT NULL,
	`record_source` text NOT NULL,
	`product_name` text NOT NULL,
	`unit_price_cents` integer NOT NULL,
	`quantity` integer NOT NULL,
	`total_cents` integer NOT NULL,
	`coupon_discount_cents` integer NOT NULL DEFAULT 0,
	`coupon_id` text,
	`note` text,
	`created_by_staff_id` text,
	`attributed_staff_id` text,
	`source_activity_id` text,
	`source_team_id` text,
	`verified_by_user_id` text,
	`verified_at` integer,
	`verification_note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`product_id`) REFERENCES `local_products`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`resident_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_staff_id`) REFERENCES `staff_accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`attributed_staff_id`) REFERENCES `staff_accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`source_team_id`) REFERENCES `activity_teams`(`id`),
	FOREIGN KEY (`verified_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`coupon_id`) REFERENCES `coupon_issues`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "local_orders_quantity_check" CHECK(`quantity` >= 1 AND `quantity` <= 99),
	CONSTRAINT "local_orders_total_check" CHECK(`total_cents` = `unit_price_cents` * `quantity`),
	CONSTRAINT "local_orders_status_check" CHECK(`status` IN ('registered', 'processing', 'pending_review', 'verified', 'online_completed', 'cancelled', 'rejected')),
	CONSTRAINT "local_orders_record_source_check" CHECK(`record_source` IN ('resident', 'staff_on_behalf'))
);
--> statement-breakpoint
INSERT INTO `local_orders_new`
  (`id`, `community_id`, `product_id`, `resident_user_id`, `idempotency_key`, `status`,
   `record_source`, `product_name`, `unit_price_cents`, `quantity`, `total_cents`,
   `coupon_discount_cents`, `coupon_id`, `note`, `created_by_staff_id`,
   `attributed_staff_id`, `source_activity_id`, `source_team_id`,
   `verified_by_user_id`, `verified_at`, `verification_note`, `created_at`, `updated_at`)
SELECT
  `id`, `community_id`, `product_id`, `resident_user_id`, `idempotency_key`, `status`,
  `record_source`, `product_name`, `unit_price_cents`, `quantity`, `total_cents`,
  `coupon_discount_cents`, `coupon_id`, `note`, `created_by_staff_id`,
  `attributed_staff_id`, `source_activity_id`, `source_team_id`,
  `verified_by_user_id`, `verified_at`, `verification_note`, `created_at`, `updated_at`
FROM `local_orders`;
--> statement-breakpoint
DROP TABLE `local_orders`;
--> statement-breakpoint
ALTER TABLE `local_orders_new` RENAME TO `local_orders`;
--> statement-breakpoint
CREATE UNIQUE INDEX `local_orders_idempotency_uq` ON `local_orders` (`community_id`,`resident_user_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `local_orders_community_status_idx` ON `local_orders` (`community_id`,`status`);
--> statement-breakpoint
CREATE INDEX `local_orders_resident_created_idx` ON `local_orders` (`resident_user_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `local_orders_product_idx` ON `local_orders` (`product_id`);
--> statement-breakpoint
CREATE INDEX `local_orders_created_by_staff_idx` ON `local_orders` (`created_by_staff_id`);
--> statement-breakpoint
CREATE INDEX `local_orders_source_team_idx` ON `local_orders` (`source_team_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_orders_active_coupon_uq` ON `local_orders`(`coupon_id`)
  WHERE `coupon_id` IS NOT NULL AND `status` NOT IN ('cancelled','rejected');
--> statement-breakpoint
-- Parent key for the payment composite FK: a payment's order, resident and
-- community must all come from the same local order row.
CREATE UNIQUE INDEX `local_orders_payment_identity_uq`
  ON `local_orders` (`id`, `resident_user_id`, `community_id`);
--> statement-breakpoint
CREATE TRIGGER `local_orders_source_activity_community_check`
BEFORE INSERT ON `local_orders`
WHEN NEW.`source_activity_id` IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'local_orders source_activity_id must belong to the order community')
	WHERE NOT EXISTS (
		SELECT 1
		FROM `activities`
		WHERE `activities`.`id` = NEW.`source_activity_id`
			AND `activities`.`community_id` = NEW.`community_id`
	);
END;
--> statement-breakpoint
CREATE TRIGGER `local_orders_source_team_check`
BEFORE INSERT ON `local_orders`
WHEN NEW.`source_team_id` IS NOT NULL
BEGIN
	-- A team without its activity would make "which activity was this order
	-- attributed to?" ambiguous, so reject the half-filled pair outright.
	SELECT RAISE(ABORT, 'local_orders source_team_id requires source_activity_id')
	WHERE NEW.`source_activity_id` IS NULL;
	-- A plain check-in activity is not a consumption reward campaign. Legacy
	-- source-only orders remain permitted, but no team may be attributed here.
	SELECT RAISE(ABORT, 'local_orders source_team_id requires a purchase reward plan')
	WHERE NOT EXISTS (
		SELECT 1 FROM `activities`
		WHERE `activities`.`id` = NEW.`source_activity_id`
			AND `activities`.`purchase_reward_plan_json` IS NOT NULL
	);
	-- The attribution must be a relation the resident already has, in the same
	-- activity, joined no later than this order was created. Another resident's
	-- team and another activity's team both fail here.
	SELECT RAISE(ABORT, 'local_orders source_team_id must be a team the resident joined in that activity')
	WHERE NOT EXISTS (
		SELECT 1
		FROM `activity_teams` AS team
		INNER JOIN `activity_participations` AS participation
			ON `participation`.`team_id` = `team`.`id`
			AND `participation`.`user_id` = NEW.`resident_user_id`
		WHERE `team`.`id` = NEW.`source_team_id`
			AND `team`.`activity_id` = NEW.`source_activity_id`
			AND `participation`.`joined_at` <= NEW.`created_at`
	);
END;
--> statement-breakpoint
CREATE TRIGGER `local_orders_attribution_immutable`
BEFORE UPDATE ON `local_orders`
WHEN OLD.`source_activity_id` IS NOT NEW.`source_activity_id`
	OR OLD.`source_team_id` IS NOT NEW.`source_team_id`
BEGIN
	SELECT RAISE(ABORT, 'local_orders attribution is immutable');
END;
--> statement-breakpoint
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
END;
--> statement-breakpoint
CREATE TRIGGER `local_orders_coupon_immutable` BEFORE UPDATE ON `local_orders`
WHEN OLD.coupon_id IS NOT NEW.coupon_id
  OR OLD.coupon_discount_cents IS NOT NEW.coupon_discount_cents
  OR OLD.total_cents IS NOT NEW.total_cents
  OR OLD.unit_price_cents IS NOT NEW.unit_price_cents
  OR OLD.quantity IS NOT NEW.quantity
BEGIN SELECT RAISE(ABORT,'order price and coupon snapshot are immutable'); END;
--> statement-breakpoint
CREATE TABLE `local_order_events_new` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`actor_user_id` text,
	`actor_staff_id` text,
	`event` text NOT NULL,
	`from_status` text,
	`to_status` text,
	`note` text,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `local_orders`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`actor_staff_id`) REFERENCES `staff_accounts`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "local_order_events_source_type_check" CHECK("source_type" = 'local_order'),
	CONSTRAINT "local_order_events_event_check" CHECK("event" IN ('order.registered', 'order.created_on_behalf', 'order.status_changed', 'order.verified', 'order.rejected', 'order.online_completed'))
);
--> statement-breakpoint
INSERT INTO `local_order_events_new`
  (`id`, `order_id`, `actor_user_id`, `actor_staff_id`, `event`, `from_status`,
   `to_status`, `note`, `source_type`, `source_id`, `created_at`)
SELECT
  `id`, `order_id`, `actor_user_id`, `actor_staff_id`, `event`, `from_status`,
  `to_status`, `note`, `source_type`, `source_id`, `created_at`
FROM `local_order_events`;
--> statement-breakpoint
DROP TABLE `local_order_events`;
--> statement-breakpoint
ALTER TABLE `local_order_events_new` RENAME TO `local_order_events`;
--> statement-breakpoint
CREATE INDEX `local_order_events_order_created_idx` ON `local_order_events` (`order_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `local_order_events_source_idx` ON `local_order_events` (`source_type`,`source_id`);
--> statement-breakpoint
CREATE TRIGGER `local_order_events_no_update`
BEFORE UPDATE ON `local_order_events`
BEGIN
	SELECT RAISE(ABORT, 'local_order_events rows are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `local_order_events_no_delete`
BEFORE DELETE ON `local_order_events`
BEGIN
	SELECT RAISE(ABORT, 'local_order_events rows are immutable');
END;
--> statement-breakpoint
CREATE TABLE `local_order_online_completions` (
	`id` text PRIMARY KEY NOT NULL,
	`local_order_id` text NOT NULL,
	`payment_intent_id` text NOT NULL,
	`kind` text NOT NULL,
	`simulated` integer NOT NULL,
	`gross_amount_cents` integer NOT NULL,
	`discount_cents` integer NOT NULL,
	`amount_cents` integer NOT NULL,
	`provider_transaction_id` text,
	`completed_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`local_order_id`) REFERENCES `local_orders`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`payment_intent_id`) REFERENCES `payment_intents`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "local_order_online_completions_kind_check" CHECK("kind" IN ('channel', 'zero_amount')),
	CONSTRAINT "local_order_online_completions_amount_check" CHECK("gross_amount_cents" >= 0
        AND "discount_cents" >= 0
        AND "amount_cents" >= 0
        AND "gross_amount_cents" - "discount_cents" = "amount_cents"),
	CONSTRAINT "local_order_online_completions_kind_facts_check" CHECK((
        ("kind" = 'zero_amount'
          AND "amount_cents" = 0
          AND "provider_transaction_id" IS NULL
          AND "simulated" = 0)
        OR
        ("kind" = 'channel'
          AND "amount_cents" > 0
          AND "provider_transaction_id" IS NOT NULL)
      )),
	CONSTRAINT "local_order_online_completions_text_check" CHECK("provider_transaction_id" IS NULL
        OR length(trim("provider_transaction_id")) BETWEEN 1 AND 128)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_order_online_completions_order_uq` ON `local_order_online_completions` (`local_order_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_order_online_completions_intent_uq` ON `local_order_online_completions` (`payment_intent_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_order_online_completions_provider_txn_uq`
  ON `local_order_online_completions` (`provider_transaction_id`)
  WHERE `provider_transaction_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `local_order_online_completions_completed_idx` ON `local_order_online_completions` (`completed_at`);
--> statement-breakpoint
-- A completion row is only legal while the order is still payable, and its
-- frozen amounts must equal the order snapshot and the paid payment intent. The
-- insert happens before the order status projection inside the same
-- transaction, so the order is still non-terminal here.
CREATE TRIGGER `local_order_online_completions_order_payable`
BEFORE INSERT ON `local_order_online_completions`
BEGIN
  SELECT RAISE(ABORT, 'online completion requires a payable order')
  WHERE NOT EXISTS (
    SELECT 1 FROM `local_orders` o
    WHERE o.id = NEW.`local_order_id`
      AND o.status IN ('registered', 'processing', 'pending_review')
      AND o.total_cents = NEW.`gross_amount_cents`
      AND o.coupon_discount_cents = NEW.`discount_cents`
      AND o.total_cents - o.coupon_discount_cents = NEW.`amount_cents`
  );
  SELECT RAISE(ABORT, 'online completion requires its own paid payment intent')
  WHERE NOT EXISTS (
    SELECT 1 FROM `payment_intents` pi
    WHERE pi.id = NEW.`payment_intent_id`
      AND pi.local_order_id = NEW.`local_order_id`
      AND pi.status = 'paid'
      AND pi.kind = NEW.`kind`
      AND pi.simulated = NEW.`simulated`
      AND pi.gross_amount_cents = NEW.`gross_amount_cents`
      AND pi.discount_cents = NEW.`discount_cents`
      AND pi.net_payable_cents = NEW.`amount_cents`
      AND (
        (NEW.`kind` = 'zero_amount' AND pi.channel IS NULL)
        OR (NEW.`kind` = 'channel' AND pi.channel IS NOT NULL)
      )
  );
END;
--> statement-breakpoint
CREATE TRIGGER `local_order_online_completions_immutable`
BEFORE UPDATE ON `local_order_online_completions`
BEGIN
  SELECT RAISE(ABORT, 'online completion facts are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `local_order_online_completions_no_delete`
BEFORE DELETE ON `local_order_online_completions`
BEGIN
  SELECT RAISE(ABORT, 'online completion facts are immutable history');
END;
--> statement-breakpoint
-- `online_completed` may only be projected together with its completion fact,
-- and is terminal afterwards: no later staff action may move it anywhere.
CREATE TRIGGER `local_orders_online_completion_fact_check`
BEFORE UPDATE OF `status` ON `local_orders`
WHEN NEW.`status` = 'online_completed' AND OLD.`status` <> 'online_completed'
BEGIN
  SELECT RAISE(ABORT, 'online_completed requires an immutable completion fact')
  WHERE NOT EXISTS (
    SELECT 1 FROM `local_order_online_completions` c
    WHERE c.local_order_id = NEW.`id`
  );
END;
--> statement-breakpoint
CREATE TRIGGER `local_orders_online_completed_terminal`
BEFORE UPDATE OF `status` ON `local_orders`
WHEN OLD.`status` = 'online_completed' AND NEW.`status` <> 'online_completed'
BEGIN
  SELECT RAISE(ABORT, 'online_completed is terminal');
END;
--> statement-breakpoint
CREATE TABLE `local_order_online_conflicts` (
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
        'payment_state_invalid', 'coupon_state_invalid', 'late_success')),
	CONSTRAINT "local_order_online_conflicts_status_check" CHECK(`status` IN ('open', 'reviewed', 'resolved')),
	CONSTRAINT "local_order_online_conflicts_detail_check" CHECK(length(trim(`detail`)) BETWEEN 1 AND 500),
	CONSTRAINT "local_order_online_conflicts_resolved_check" CHECK(((`status` = 'resolved') = (`resolved_at` IS NOT NULL)))
);
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
-- Only review bookkeeping may change; the preserved payment evidence may not.
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
