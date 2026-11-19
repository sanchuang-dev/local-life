-- PAY-03 (#278): durable downstream handoff and reviewable conflict evidence.
-- This migration does not modify 0031 payment tables or any local order/ledger row.
-- Outbox/exception rows are append-only history: deletes and evidence mutation are rejected;
-- only delivery/resolution bookkeeping columns remain updatable.
CREATE TABLE `payment_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`payment_intent_id` text NOT NULL,
	`payment_event_id` text NOT NULL,
	`topic` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer NOT NULL,
	`available_at` integer NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`delivered_at` integer,
	FOREIGN KEY (`payment_intent_id`) REFERENCES `payment_intents` (`id`)
		ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`payment_event_id`) REFERENCES `payment_events` (`id`)
		ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "payment_outbox_topic_check" CHECK(`topic` = 'payment.paid.v1'),
	CONSTRAINT "payment_outbox_status_check" CHECK(
		`status` IN ('pending', 'processing', 'delivered', 'failed')
	),
	CONSTRAINT "payment_outbox_attempts_check" CHECK(`attempts` >= 0),
	CONSTRAINT "payment_outbox_delivery_check" CHECK(
		((`status` = 'delivered') = (`delivered_at` IS NOT NULL))
	),
	CONSTRAINT "payment_outbox_text_check" CHECK(
		length(trim(`dedupe_key`)) BETWEEN 1 AND 200
		AND length(trim(`payload_json`)) > 0
		AND (`last_error` IS NULL OR length(trim(`last_error`)) BETWEEN 1 AND 500)
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_outbox_event_uq` ON `payment_outbox` (`payment_event_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_outbox_dedupe_uq` ON `payment_outbox` (`dedupe_key`);
--> statement-breakpoint
CREATE INDEX `payment_outbox_status_available_idx` ON `payment_outbox` (`status`, `available_at`);
--> statement-breakpoint
CREATE INDEX `payment_outbox_intent_idx` ON `payment_outbox` (`payment_intent_id`);
--> statement-breakpoint
CREATE TABLE `payment_review_exceptions` (
	`id` text PRIMARY KEY NOT NULL,
	`payment_intent_id` text,
	`merchant_order_no` text NOT NULL,
	`channel` text NOT NULL,
	`provider_transaction_id` text,
	`amount_cents` integer,
	`merchant_app_id` text,
	`merchant_id` text,
	`observed_at` integer NOT NULL,
	`source` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`provider_event_ref` text,
	`failure_code` text,
	`failure_message` text,
	`kind` text NOT NULL,
	`detail` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`payment_intent_id`) REFERENCES `payment_intents` (`id`)
		ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "payment_review_exceptions_channel_check" CHECK(
		`channel` IN ('mock', 'wechat_jsapi')
	),
	CONSTRAINT "payment_review_exceptions_source_check" CHECK(
		`source` IN ('notification', 'query')
	),
	CONSTRAINT "payment_review_exceptions_kind_check" CHECK(
		`kind` IN ('intent_not_found', 'amount_mismatch', 'merchant_mismatch',
			'channel_mismatch', 'ownership_mismatch', 'transaction_conflict',
			'late_success_after_closed', 'late_success_after_failed', 'terminal_conflict',
			'unknown_evidence')
	),
	CONSTRAINT "payment_review_exceptions_status_check" CHECK(
		`status` IN ('open', 'reviewed', 'resolved')
	),
	CONSTRAINT "payment_review_exceptions_amount_check" CHECK(
		`amount_cents` IS NULL OR `amount_cents` >= 0
	),
	CONSTRAINT "payment_review_exceptions_text_check" CHECK(
		length(trim(`merchant_order_no`)) BETWEEN 6 AND 32
		AND length(trim(`dedupe_key`)) BETWEEN 1 AND 200
		AND length(trim(`detail`)) BETWEEN 1 AND 500
		AND (`provider_transaction_id` IS NULL
			OR length(trim(`provider_transaction_id`)) BETWEEN 1 AND 128)
		AND (`merchant_app_id` IS NULL OR length(trim(`merchant_app_id`)) BETWEEN 1 AND 64)
		AND (`merchant_id` IS NULL OR length(trim(`merchant_id`)) BETWEEN 1 AND 64)
		AND (`provider_event_ref` IS NULL
			OR length(trim(`provider_event_ref`)) BETWEEN 1 AND 128)
		AND (`failure_code` IS NULL OR length(trim(`failure_code`)) BETWEEN 1 AND 64)
		AND (`failure_message` IS NULL OR length(trim(`failure_message`)) BETWEEN 1 AND 500)
		AND ((`status` = 'resolved') = (`resolved_at` IS NOT NULL))
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_review_exceptions_dedupe_uq`
  ON `payment_review_exceptions` (`dedupe_key`);
--> statement-breakpoint
CREATE INDEX `payment_review_exceptions_status_created_idx`
  ON `payment_review_exceptions` (`status`, `created_at`);
--> statement-breakpoint
CREATE INDEX `payment_review_exceptions_intent_idx`
  ON `payment_review_exceptions` (`payment_intent_id`);
--> statement-breakpoint
CREATE TRIGGER `payment_outbox_no_delete`
BEFORE DELETE ON `payment_outbox`
BEGIN
  SELECT RAISE(ABORT, 'payment outbox rows are durable history');
END;
--> statement-breakpoint
CREATE TRIGGER `payment_review_exceptions_no_delete`
BEFORE DELETE ON `payment_review_exceptions`
BEGIN
  SELECT RAISE(ABORT, 'payment review exceptions are durable history');
END;
--> statement-breakpoint
CREATE TRIGGER `payment_outbox_immutable_identity`
BEFORE UPDATE ON `payment_outbox`
WHEN OLD.`id` IS NOT NEW.`id`
  OR OLD.`payment_intent_id` IS NOT NEW.`payment_intent_id`
  OR OLD.`payment_event_id` IS NOT NEW.`payment_event_id`
  OR OLD.`topic` IS NOT NEW.`topic`
  OR OLD.`dedupe_key` IS NOT NEW.`dedupe_key`
  OR OLD.`payload_json` IS NOT NEW.`payload_json`
  OR OLD.`created_at` IS NOT NEW.`created_at`
BEGIN
  SELECT RAISE(ABORT, 'payment outbox identity and payload are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `payment_review_exceptions_immutable_evidence`
BEFORE UPDATE ON `payment_review_exceptions`
WHEN OLD.`id` IS NOT NEW.`id`
  OR OLD.`payment_intent_id` IS NOT NEW.`payment_intent_id`
  OR OLD.`merchant_order_no` IS NOT NEW.`merchant_order_no`
  OR OLD.`channel` IS NOT NEW.`channel`
  OR OLD.`provider_transaction_id` IS NOT NEW.`provider_transaction_id`
  OR OLD.`amount_cents` IS NOT NEW.`amount_cents`
  OR OLD.`merchant_app_id` IS NOT NEW.`merchant_app_id`
  OR OLD.`merchant_id` IS NOT NEW.`merchant_id`
  OR OLD.`observed_at` IS NOT NEW.`observed_at`
  OR OLD.`source` IS NOT NEW.`source`
  OR OLD.`dedupe_key` IS NOT NEW.`dedupe_key`
  OR OLD.`provider_event_ref` IS NOT NEW.`provider_event_ref`
  OR OLD.`failure_code` IS NOT NEW.`failure_code`
  OR OLD.`failure_message` IS NOT NEW.`failure_message`
  OR OLD.`kind` IS NOT NEW.`kind`
  OR OLD.`detail` IS NOT NEW.`detail`
  OR OLD.`created_at` IS NOT NEW.`created_at`
BEGIN
  SELECT RAISE(ABORT, 'payment review exception evidence is immutable');
END;
