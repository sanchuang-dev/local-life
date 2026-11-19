-- PAY-01 (#276): independent payment intent / attempt / event truth source.
-- This migration only adds tables, indexes and triggers; it does not touch the
-- existing local order rows, manual payment evidence or immutable ledger facts.
CREATE UNIQUE INDEX `local_orders_payment_identity_uq`
  ON `local_orders` (`id`, `resident_user_id`, `community_id`);
--> statement-breakpoint
CREATE TABLE `payment_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`local_order_id` text NOT NULL,
	`resident_user_id` text NOT NULL,
	`community_id` text NOT NULL,
	`kind` text NOT NULL,
	`channel` text,
	`simulated` integer NOT NULL,
	`merchant_order_no` text NOT NULL,
	`merchant_app_id` text,
	`merchant_id` text,
	`gross_amount_cents` integer NOT NULL,
	`discount_cents` integer NOT NULL,
	`net_payable_cents` integer NOT NULL,
	`status` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`expires_at` integer NOT NULL,
	`paid_at` integer,
	`closed_at` integer,
	`failed_at` integer,
	`failure_code` text,
	`failure_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`local_order_id`, `resident_user_id`, `community_id`)
		REFERENCES `local_orders` (`id`, `resident_user_id`, `community_id`)
		ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "payment_intents_kind_channel_check" CHECK(
		`simulated` IN (0, 1)
		AND (
			(`kind` = 'channel'
				AND `channel` IN ('mock', 'wechat_jsapi')
				AND `net_payable_cents` > 0
				AND ((`channel` = 'mock' AND `simulated` = 1)
					OR (`channel` = 'wechat_jsapi' AND `simulated` = 0)))
			OR
			(`kind` = 'zero_amount'
				AND `channel` IS NULL
				AND `simulated` = 0
				AND `net_payable_cents` = 0
				AND `status` = 'paid'
				AND `paid_at` IS NOT NULL)
		)
	),
	CONSTRAINT "payment_intents_amount_check" CHECK(
		typeof(`gross_amount_cents`) = 'integer'
		AND typeof(`discount_cents`) = 'integer'
		AND typeof(`net_payable_cents`) = 'integer'
		AND `gross_amount_cents` >= 0
		AND `discount_cents` >= 0
		AND `net_payable_cents` >= 0
		AND `gross_amount_cents` <= 9007199254740991
		AND `discount_cents` <= 9007199254740991
		AND `net_payable_cents` <= 9007199254740991
		AND `gross_amount_cents` - `discount_cents` = `net_payable_cents`
	),
	CONSTRAINT "payment_intents_status_check" CHECK(
		`status` IN ('pending', 'confirming', 'paid', 'closed', 'failed')
	),
	CONSTRAINT "payment_intents_terminal_time_check" CHECK(
		((`status` = 'paid') = (`paid_at` IS NOT NULL))
		AND ((`status` = 'closed') = (`closed_at` IS NOT NULL))
		AND ((`status` = 'failed') = (`failed_at` IS NOT NULL))
		AND (`status` = 'failed' OR (`failure_code` IS NULL AND `failure_message` IS NULL))
	),
	CONSTRAINT "payment_intents_time_order_check" CHECK(
		`expires_at` > `created_at` AND `updated_at` >= `created_at`
	),
	CONSTRAINT "payment_intents_text_check" CHECK(
		length(trim(`merchant_order_no`)) BETWEEN 1 AND 64
		AND length(trim(`idempotency_key`)) BETWEEN 8 AND 128
		AND (`merchant_app_id` IS NULL OR length(trim(`merchant_app_id`)) BETWEEN 1 AND 64)
		AND (`merchant_id` IS NULL OR length(trim(`merchant_id`)) BETWEEN 1 AND 64)
		AND (`failure_code` IS NULL OR length(trim(`failure_code`)) BETWEEN 1 AND 64)
		AND (`failure_message` IS NULL OR length(trim(`failure_message`)) BETWEEN 1 AND 500)
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_intents_merchant_order_uq` ON `payment_intents` (`merchant_order_no`);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_intents_idempotency_uq` ON `payment_intents` (`idempotency_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_intents_one_paid_per_order_uq`
  ON `payment_intents` (`local_order_id`)
  WHERE `status` = 'paid';
--> statement-breakpoint
CREATE INDEX `payment_intents_order_created_idx` ON `payment_intents` (`local_order_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `payment_intents_status_created_idx` ON `payment_intents` (`status`, `created_at`);
--> statement-breakpoint
CREATE TABLE `payment_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`payment_intent_id` text NOT NULL,
	`attempt_no` integer NOT NULL,
	`status` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`provider_transaction_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`confirmed_at` integer,
	`closed_at` integer,
	`failed_at` integer,
	`failure_code` text,
	`failure_message` text,
	FOREIGN KEY (`payment_intent_id`) REFERENCES `payment_intents` (`id`)
		ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "payment_attempts_attempt_no_check" CHECK(`attempt_no` >= 1),
	CONSTRAINT "payment_attempts_status_check" CHECK(
		`status` IN ('pending', 'confirming', 'paid', 'closed', 'failed')
	),
	CONSTRAINT "payment_attempts_terminal_time_check" CHECK(
		((`status` = 'paid') = (`confirmed_at` IS NOT NULL))
		AND ((`status` = 'closed') = (`closed_at` IS NOT NULL))
		AND ((`status` = 'failed') = (`failed_at` IS NOT NULL))
		AND (`status` = 'failed' OR (`failure_code` IS NULL AND `failure_message` IS NULL))
		AND (`status` <> 'paid' OR `provider_transaction_id` IS NOT NULL)
	),
	CONSTRAINT "payment_attempts_text_check" CHECK(
		length(trim(`idempotency_key`)) BETWEEN 8 AND 128
		AND (`provider_transaction_id` IS NULL OR length(trim(`provider_transaction_id`)) BETWEEN 1 AND 128)
		AND (`failure_code` IS NULL OR length(trim(`failure_code`)) BETWEEN 1 AND 64)
		AND (`failure_message` IS NULL OR length(trim(`failure_message`)) BETWEEN 1 AND 500)
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_attempts_intent_no_uq` ON `payment_attempts` (`payment_intent_id`, `attempt_no`);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_attempts_idempotency_uq` ON `payment_attempts` (`idempotency_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_attempts_provider_txn_uq` ON `payment_attempts` (`provider_transaction_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_attempts_one_paid_per_intent_uq`
  ON `payment_attempts` (`payment_intent_id`)
  WHERE `status` = 'paid';
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_attempts_id_intent_uq` ON `payment_attempts` (`id`, `payment_intent_id`);
--> statement-breakpoint
CREATE INDEX `payment_attempts_intent_created_idx` ON `payment_attempts` (`payment_intent_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE `payment_events` (
	`id` text PRIMARY KEY NOT NULL,
	`payment_intent_id` text NOT NULL,
	`payment_attempt_id` text,
	`event_type` text NOT NULL,
	`source` text NOT NULL,
	`from_status` text,
	`to_status` text,
	`provider_event_ref` text,
	`dedupe_key` text,
	`note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`payment_intent_id`) REFERENCES `payment_intents` (`id`)
		ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`payment_attempt_id`, `payment_intent_id`)
		REFERENCES `payment_attempts` (`id`, `payment_intent_id`)
		ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "payment_events_type_check" CHECK(
		`event_type` IN ('payment.intent_created', 'payment.attempt_created',
			'payment.status_changed', 'payment.channel_notification', 'payment.channel_query')
	),
	CONSTRAINT "payment_events_source_check" CHECK(
		`source` IN ('system', 'channel', 'admin', 'reconciliation')
	),
	CONSTRAINT "payment_events_status_check" CHECK(
		(`from_status` IS NULL OR `from_status` IN ('pending', 'confirming', 'paid', 'closed', 'failed'))
		AND (`to_status` IS NULL OR `to_status` IN ('pending', 'confirming', 'paid', 'closed', 'failed'))
	),
	CONSTRAINT "payment_events_text_check" CHECK(
		(`provider_event_ref` IS NULL OR length(trim(`provider_event_ref`)) BETWEEN 1 AND 128)
		AND (`dedupe_key` IS NULL OR length(trim(`dedupe_key`)) BETWEEN 1 AND 200)
		AND (`note` IS NULL OR length(trim(`note`)) BETWEEN 1 AND 500)
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_events_dedupe_uq` ON `payment_events` (`dedupe_key`);
--> statement-breakpoint
CREATE INDEX `payment_events_intent_created_idx` ON `payment_events` (`payment_intent_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `payment_events_attempt_idx` ON `payment_events` (`payment_attempt_id`);
--> statement-breakpoint
-- A payment snapshot must come from the exact local order row, not merely any
-- order UUID. The composite FK checks owner/community; this trigger checks money.
CREATE TRIGGER `payment_intents_order_snapshot_check`
BEFORE INSERT ON `payment_intents`
WHEN NOT EXISTS (
  SELECT 1 FROM `local_orders`
  WHERE `id` = NEW.`local_order_id`
    AND `resident_user_id` = NEW.`resident_user_id`
    AND `community_id` = NEW.`community_id`
    AND `total_cents` = NEW.`gross_amount_cents`
    AND `coupon_discount_cents` = NEW.`discount_cents`
    AND `total_cents` - `coupon_discount_cents` = NEW.`net_payable_cents`
)
BEGIN
  SELECT RAISE(ABORT, 'payment amounts or ownership do not match local order');
END;
--> statement-breakpoint
-- Identity and amount columns are snapshots; only lifecycle columns may change.
CREATE TRIGGER `payment_intents_identity_immutable`
BEFORE UPDATE ON `payment_intents`
WHEN OLD.`local_order_id` IS NOT NEW.`local_order_id`
  OR OLD.`resident_user_id` IS NOT NEW.`resident_user_id`
  OR OLD.`community_id` IS NOT NEW.`community_id`
  OR OLD.`kind` IS NOT NEW.`kind`
  OR OLD.`channel` IS NOT NEW.`channel`
  OR OLD.`simulated` IS NOT NEW.`simulated`
  OR OLD.`merchant_order_no` IS NOT NEW.`merchant_order_no`
  OR OLD.`merchant_app_id` IS NOT NEW.`merchant_app_id`
  OR OLD.`merchant_id` IS NOT NEW.`merchant_id`
  OR OLD.`gross_amount_cents` IS NOT NEW.`gross_amount_cents`
  OR OLD.`discount_cents` IS NOT NEW.`discount_cents`
  OR OLD.`net_payable_cents` IS NOT NEW.`net_payable_cents`
  OR OLD.`idempotency_key` IS NOT NEW.`idempotency_key`
  OR OLD.`expires_at` IS NOT NEW.`expires_at`
  OR OLD.`created_at` IS NOT NEW.`created_at`
BEGIN
  SELECT RAISE(ABORT, 'payment intent identity and amount are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `payment_intents_terminal_immutable`
BEFORE UPDATE ON `payment_intents`
WHEN OLD.`status` IN ('paid', 'closed', 'failed')
  AND (NEW.`paid_at` IS NOT OLD.`paid_at`
    OR NEW.`closed_at` IS NOT OLD.`closed_at`
    OR NEW.`failed_at` IS NOT OLD.`failed_at`
    OR NEW.`failure_code` IS NOT OLD.`failure_code`
    OR NEW.`failure_message` IS NOT OLD.`failure_message`)
BEGIN
  SELECT RAISE(ABORT, 'terminal payment intent facts are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `payment_intents_status_transition`
BEFORE UPDATE OF `status` ON `payment_intents`
WHEN OLD.`status` <> NEW.`status`
  AND NOT (
    (OLD.`status` = 'pending' AND NEW.`status` IN ('confirming', 'paid', 'closed', 'failed'))
    OR (OLD.`status` = 'confirming' AND NEW.`status` IN ('paid', 'closed', 'failed'))
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid payment status transition');
END;
--> statement-breakpoint
CREATE TRIGGER `payment_attempts_identity_immutable`
BEFORE UPDATE ON `payment_attempts`
WHEN OLD.`payment_intent_id` IS NOT NEW.`payment_intent_id`
  OR OLD.`attempt_no` IS NOT NEW.`attempt_no`
  OR OLD.`idempotency_key` IS NOT NEW.`idempotency_key`
  OR OLD.`created_at` IS NOT NEW.`created_at`
BEGIN
  SELECT RAISE(ABORT, 'payment attempt identity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `payment_attempts_paid_immutable`
BEFORE UPDATE ON `payment_attempts`
WHEN OLD.`status` = 'paid'
  AND (NEW.`status` IS NOT 'paid'
    OR NEW.`provider_transaction_id` IS NOT OLD.`provider_transaction_id`
    OR NEW.`confirmed_at` IS NOT OLD.`confirmed_at`)
BEGIN
  SELECT RAISE(ABORT, 'paid payment attempt is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `payment_attempts_terminal_immutable`
BEFORE UPDATE ON `payment_attempts`
WHEN OLD.`status` IN ('paid', 'closed', 'failed')
  AND (NEW.`confirmed_at` IS NOT OLD.`confirmed_at`
    OR NEW.`closed_at` IS NOT OLD.`closed_at`
    OR NEW.`failed_at` IS NOT OLD.`failed_at`
    OR NEW.`failure_code` IS NOT OLD.`failure_code`
    OR NEW.`failure_message` IS NOT OLD.`failure_message`)
BEGIN
  SELECT RAISE(ABORT, 'terminal payment attempt facts are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `payment_attempts_status_transition`
BEFORE UPDATE OF `status` ON `payment_attempts`
WHEN OLD.`status` <> NEW.`status`
  AND NOT (
    (OLD.`status` = 'pending' AND NEW.`status` IN ('confirming', 'paid', 'closed', 'failed'))
    OR (OLD.`status` = 'confirming' AND NEW.`status` IN ('paid', 'closed', 'failed'))
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid payment attempt status transition');
END;
--> statement-breakpoint
CREATE TRIGGER `payment_intents_no_delete`
BEFORE DELETE ON `payment_intents`
BEGIN
  SELECT RAISE(ABORT, 'payment intents are immutable history');
END;
--> statement-breakpoint
CREATE TRIGGER `payment_attempts_no_delete`
BEFORE DELETE ON `payment_attempts`
BEGIN
  SELECT RAISE(ABORT, 'payment attempts are immutable history');
END;
--> statement-breakpoint
CREATE TRIGGER `payment_events_no_update`
BEFORE UPDATE ON `payment_events`
BEGIN
  SELECT RAISE(ABORT, 'payment events are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `payment_events_no_delete`
BEFORE DELETE ON `payment_events`
BEGIN
  SELECT RAISE(ABORT, 'payment events are append-only');
END;
