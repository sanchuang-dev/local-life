CREATE TABLE `ledger_payment_order_links` (
	`order_id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`evidence_key` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `local_orders`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`entry_id`) REFERENCES `ledger_entries`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_payment_order_links_entry_uq` ON `ledger_payment_order_links` (`entry_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_payment_order_links_evidence_uq` ON `ledger_payment_order_links` (`evidence_key`);
--> statement-breakpoint
-- Link writes must point to a verified local order and the SAME community
-- as a real append-only manual receipt. No fabricated or crossed evidence.
CREATE TRIGGER ledger_payment_order_links_insert_guard
BEFORE INSERT ON ledger_payment_order_links
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM local_orders o
    JOIN ledger_entries e ON e.id = NEW.entry_id
    WHERE o.id = NEW.order_id
      AND o.status = 'verified'
      AND o.verified_at IS NOT NULL
      AND o.community_id = e.community_id
      AND e.fact_kind = 'payment_received'
      AND e.source_system = 'manual'
      AND e.recorded_by_staff_id IS NOT NULL
      AND e.evidence_ref IS NOT NULL
  ) THEN RAISE(ABORT, 'invalid order payment evidence link') END;
END;
--> statement-breakpoint
CREATE TRIGGER ledger_payment_order_links_no_update
BEFORE UPDATE ON ledger_payment_order_links
BEGIN
  SELECT RAISE(ABORT, 'order payment evidence links are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER ledger_payment_order_links_no_delete
BEFORE DELETE ON ledger_payment_order_links
BEGIN
  SELECT RAISE(ABORT, 'order payment evidence links are append-only');
END;
