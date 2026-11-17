-- PAY-03: bind provider event keys to exact normalized evidence.
-- Older rows are intentionally left without a fabricated fingerprint. Replays
-- against such rows fail closed and preserve the new observation as an anomaly.
ALTER TABLE `payment_events` ADD COLUMN `evidence_fingerprint` text;
--> statement-breakpoint
ALTER TABLE `payment_review_exceptions`
  ADD COLUMN `evidence_fingerprint` text NOT NULL DEFAULT '';
--> statement-breakpoint
DROP INDEX `payment_review_exceptions_dedupe_uq`;
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_review_exceptions_dedupe_fingerprint_uq`
  ON `payment_review_exceptions` (`dedupe_key`, `evidence_fingerprint`);
--> statement-breakpoint
DROP TRIGGER `payment_review_exceptions_immutable_evidence`;
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
  OR OLD.`evidence_fingerprint` IS NOT NEW.`evidence_fingerprint`
  OR OLD.`provider_event_ref` IS NOT NEW.`provider_event_ref`
  OR OLD.`failure_code` IS NOT NEW.`failure_code`
  OR OLD.`failure_message` IS NOT NEW.`failure_message`
  OR OLD.`kind` IS NOT NEW.`kind`
  OR OLD.`detail` IS NOT NEW.`detail`
  OR OLD.`created_at` IS NOT NEW.`created_at`
BEGIN
  SELECT RAISE(ABORT, 'payment review exception evidence is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `payment_events_evidence_fingerprint_check`
BEFORE INSERT ON `payment_events`
WHEN (
  NEW.`event_type` IN ('payment.channel_notification', 'payment.channel_query')
  AND (
    NEW.`evidence_fingerprint` IS NULL
    OR length(NEW.`evidence_fingerprint`) <> 64
    OR NEW.`evidence_fingerprint` GLOB '*[^0-9a-f]*'
  )
) OR (
  NEW.`event_type` NOT IN ('payment.channel_notification', 'payment.channel_query')
  AND NEW.`evidence_fingerprint` IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'payment channel events require a normalized evidence fingerprint');
END;
--> statement-breakpoint
CREATE TRIGGER `payment_review_exceptions_evidence_fingerprint_check`
BEFORE INSERT ON `payment_review_exceptions`
WHEN length(NEW.`evidence_fingerprint`) <> 64
  OR NEW.`evidence_fingerprint` GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'payment review exceptions require an evidence fingerprint');
END;
