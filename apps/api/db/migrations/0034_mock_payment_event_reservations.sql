-- PAY-04: atomically reserve the first Mock provider observation clock.
-- No FK is intentional: the reservation survives a failed PAY-03 confirmation.
CREATE TABLE `mock_payment_event_reservations` (
  `dedupe_key` text PRIMARY KEY NOT NULL,
  `observed_at` integer NOT NULL,
  CONSTRAINT `mock_payment_event_reservations_key_check`
    CHECK (`dedupe_key` GLOB 'MOCK-EVT-*'
      AND length(trim(`dedupe_key`)) BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TRIGGER `mock_payment_event_reservations_immutable_update`
BEFORE UPDATE ON `mock_payment_event_reservations`
BEGIN
  SELECT RAISE(ABORT, 'mock payment event reservation is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `mock_payment_event_reservations_immutable_delete`
BEFORE DELETE ON `mock_payment_event_reservations`
BEGIN
  SELECT RAISE(ABORT, 'mock payment event reservation is immutable');
END;
