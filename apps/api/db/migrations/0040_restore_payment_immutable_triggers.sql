-- Upgrade repair for historical databases whose 0032 hash predates the
-- immutable trigger definitions. Re-assert both security invariants without
-- changing or deleting payment evidence. SQLite's IF NOT EXISTS is idempotent.
CREATE TRIGGER IF NOT EXISTS `payment_outbox_immutable_identity`
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
CREATE TRIGGER IF NOT EXISTS `payment_review_exceptions_immutable_evidence`
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
