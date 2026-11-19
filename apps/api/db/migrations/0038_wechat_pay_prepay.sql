-- PAY-10 (#285): WeChat Pay APIv3 JSAPI prepay outbound audit/idempotency.
-- This migration is additive only. It does not modify 0031-0037, does not add
-- a second payment intent, does not touch local orders/ledger facts and does
-- not introduce any paid/payment_received state. `prepay_id` here is a
-- short-lived pre-payment credential, kept separate from
-- `payment_attempts.provider_transaction_id`.
CREATE TABLE `wechat_pay_prepay_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`payment_intent_id` text NOT NULL,
	`attempt_no` integer NOT NULL,
	`status` text NOT NULL,
	`request_fingerprint` text NOT NULL,
	`out_trade_no` text NOT NULL,
	`appid` text NOT NULL,
	`mchid` text NOT NULL,
	`payer_openid_sha256` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`time_expire_at` integer NOT NULL,
	`request_method` text NOT NULL,
	`request_path` text NOT NULL,
	`request_body_sha256` text NOT NULL,
	`request_body_redacted_json` text NOT NULL,
	`request_created_at` integer NOT NULL,
	`response_status` integer,
	`response_request_id` text,
	`response_body_sha256` text,
	`response_error_code` text,
	`response_error_message` text,
	`prepay_id` text,
	`prepay_expires_at` integer,
	`failure_code` text,
	`failure_message` text,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`payment_intent_id`) REFERENCES `payment_intents` (`id`)
		ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "wechat_pay_prepay_attempts_status_check" CHECK(
		`status` IN ('requesting', 'succeeded', 'rejected', 'uncertain')
	),
	CONSTRAINT "wechat_pay_prepay_attempts_attempt_no_check" CHECK(`attempt_no` >= 1),
	CONSTRAINT "wechat_pay_prepay_attempts_amount_check" CHECK(`amount_cents` > 0),
	CONSTRAINT "wechat_pay_prepay_attempts_request_check" CHECK(
		`request_method` = 'POST'
		AND length(`request_path`) BETWEEN 1 AND 128
		AND length(`request_body_redacted_json`) > 0
		AND length(`request_fingerprint`) = 64
		AND `request_fingerprint` NOT GLOB '*[^0-9a-f]*'
		AND length(`request_body_sha256`) = 64
		AND `request_body_sha256` NOT GLOB '*[^0-9a-f]*'
		AND length(`payer_openid_sha256`) = 64
		AND `payer_openid_sha256` NOT GLOB '*[^0-9a-f]*'
	),
	CONSTRAINT "wechat_pay_prepay_attempts_response_hash_check" CHECK(
		`response_body_sha256` IS NULL OR (
			length(`response_body_sha256`) = 64
			AND `response_body_sha256` NOT GLOB '*[^0-9a-f]*'
		)
	),
	CONSTRAINT "wechat_pay_prepay_attempts_prepay_check" CHECK(
		((`status` = 'succeeded') = (`prepay_id` IS NOT NULL))
		AND ((`status` = 'succeeded') = (`prepay_expires_at` IS NOT NULL))
		AND (`status` <> 'succeeded' OR `response_status` = 200)
		AND (`prepay_id` IS NULL OR length(`prepay_id`) BETWEEN 1 AND 128)
		AND (`prepay_expires_at` IS NULL OR `prepay_expires_at` > `request_created_at`)
	),
	CONSTRAINT "wechat_pay_prepay_attempts_lifecycle_check" CHECK(
		((`status` = 'requesting') = (`completed_at` IS NULL))
		AND (`time_expire_at` > `request_created_at`)
		AND `updated_at` >= `created_at`
	),
	CONSTRAINT "wechat_pay_prepay_attempts_failure_check" CHECK(
		(`status` IN ('rejected', 'uncertain')
			OR (`failure_code` IS NULL AND `failure_message` IS NULL))
		AND (`failure_code` IS NULL OR length(trim(`failure_code`)) BETWEEN 1 AND 64)
		AND (`failure_message` IS NULL OR length(trim(`failure_message`)) BETWEEN 1 AND 500)
	),
	CONSTRAINT "wechat_pay_prepay_attempts_text_check" CHECK(
		length(trim(`out_trade_no`)) BETWEEN 6 AND 32
		AND length(trim(`appid`)) BETWEEN 1 AND 64
		AND length(trim(`mchid`)) BETWEEN 1 AND 64
		AND (`response_status` IS NULL OR `response_status` BETWEEN 100 AND 599)
		AND (`response_request_id` IS NULL OR length(trim(`response_request_id`)) BETWEEN 1 AND 128)
		AND (`response_error_code` IS NULL OR length(trim(`response_error_code`)) BETWEEN 1 AND 64)
		AND (`response_error_message` IS NULL OR length(trim(`response_error_message`)) BETWEEN 1 AND 500)
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wechat_pay_prepay_attempts_intent_no_uq`
  ON `wechat_pay_prepay_attempts` (`payment_intent_id`, `attempt_no`);
--> statement-breakpoint
CREATE UNIQUE INDEX `wechat_pay_prepay_attempts_prepay_uq`
  ON `wechat_pay_prepay_attempts` (`prepay_id`)
  WHERE `prepay_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `wechat_pay_prepay_attempts_intent_status_idx`
  ON `wechat_pay_prepay_attempts` (`payment_intent_id`, `status`);
--> statement-breakpoint
CREATE INDEX `wechat_pay_prepay_attempts_intent_fingerprint_idx`
  ON `wechat_pay_prepay_attempts` (`payment_intent_id`, `request_fingerprint`);
--> statement-breakpoint
CREATE INDEX `wechat_pay_prepay_attempts_status_created_idx`
  ON `wechat_pay_prepay_attempts` (`status`, `created_at`);
--> statement-breakpoint
-- The outbound request snapshot is immutable; only the terminal result columns
-- (status/response/prepay/failure/completed_at/updated_at) may be written once.
CREATE TRIGGER `wechat_pay_prepay_attempts_request_immutable`
BEFORE UPDATE ON `wechat_pay_prepay_attempts`
WHEN OLD.`payment_intent_id` IS NOT NEW.`payment_intent_id`
  OR OLD.`attempt_no` IS NOT NEW.`attempt_no`
  OR OLD.`request_fingerprint` IS NOT NEW.`request_fingerprint`
  OR OLD.`out_trade_no` IS NOT NEW.`out_trade_no`
  OR OLD.`appid` IS NOT NEW.`appid`
  OR OLD.`mchid` IS NOT NEW.`mchid`
  OR OLD.`payer_openid_sha256` IS NOT NEW.`payer_openid_sha256`
  OR OLD.`amount_cents` IS NOT NEW.`amount_cents`
  OR OLD.`time_expire_at` IS NOT NEW.`time_expire_at`
  OR OLD.`request_method` IS NOT NEW.`request_method`
  OR OLD.`request_path` IS NOT NEW.`request_path`
  OR OLD.`request_body_sha256` IS NOT NEW.`request_body_sha256`
  OR OLD.`request_body_redacted_json` IS NOT NEW.`request_body_redacted_json`
  OR OLD.`request_created_at` IS NOT NEW.`request_created_at`
  OR OLD.`created_at` IS NOT NEW.`created_at`
BEGIN
  SELECT RAISE(ABORT, 'wechat pay prepay request snapshot is immutable');
END;
--> statement-breakpoint
-- A completed prepay attempt is append-only history: no late status rewrites.
CREATE TRIGGER `wechat_pay_prepay_attempts_terminal_immutable`
BEFORE UPDATE ON `wechat_pay_prepay_attempts`
WHEN OLD.`status` <> 'requesting'
BEGIN
  SELECT RAISE(ABORT, 'terminal wechat pay prepay attempt is immutable');
END;
--> statement-breakpoint
-- Only the single reservation -> terminal result transition is allowed.
CREATE TRIGGER `wechat_pay_prepay_attempts_status_transition`
BEFORE UPDATE OF `status` ON `wechat_pay_prepay_attempts`
WHEN OLD.`status` <> NEW.`status`
  AND NOT (
    OLD.`status` = 'requesting'
    AND NEW.`status` IN ('succeeded', 'rejected', 'uncertain')
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid wechat pay prepay status transition');
END;
--> statement-breakpoint
CREATE TRIGGER `wechat_pay_prepay_attempts_no_delete`
BEFORE DELETE ON `wechat_pay_prepay_attempts`
BEGIN
  SELECT RAISE(ABORT, 'wechat pay prepay attempts are immutable history');
END;
