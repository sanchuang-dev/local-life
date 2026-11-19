-- PAY-11 (#286): audit only. No payment/ledger state is derivable from these rows.
-- The absence of a verified provider CLOSED reply must NEVER imply closure.
CREATE TABLE `wechat_pay_recovery_checks` (
  `id` text PRIMARY KEY NOT NULL,
  `payment_intent_id` text NOT NULL,
  `operation` text NOT NULL,
  `result` text NOT NULL,
  `detail_code` text NOT NULL,
  `response_sha256` text,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`payment_intent_id`) REFERENCES `payment_intents`(`id`) ON DELETE RESTRICT,
  CONSTRAINT `wechat_pay_recovery_checks_operation_check`
    CHECK (`operation` IN ('query', 'close', 'post_close_query')),
  CONSTRAINT `wechat_pay_recovery_checks_result_check`
    CHECK (`result` IN ('verified', 'uncertain', 'request_sent')),
  CONSTRAINT `wechat_pay_recovery_checks_detail_check`
    CHECK (length(trim(`detail_code`)) BETWEEN 1 AND 80),
  CONSTRAINT `wechat_pay_recovery_checks_hash_check`
    CHECK (`response_sha256` IS NULL OR (
      length(`response_sha256`) = 64 AND
      `response_sha256` NOT GLOB '*[^0-9a-f]*'
    ))
);
--> statement-breakpoint
CREATE INDEX `wechat_pay_recovery_checks_intent_created_idx`
  ON `wechat_pay_recovery_checks` (`payment_intent_id`, `created_at`);
