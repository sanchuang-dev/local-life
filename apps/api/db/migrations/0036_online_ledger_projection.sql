-- PAY-06 (#281): project PAY-05 online completions into the existing operating
-- ledger without creating a second financial system.
--
-- SQLite cannot extend a CHECK constraint in place, so `ledger_entries` and
-- `ledger_entry_sources` are rebuilt with their previous columns/indexes/triggers
-- and copied byte-for-byte. Historical manual rows get `simulated = 0`.
--
-- New distinctions:
--   * `source_system = 'online_payment'` is a distinct producer, never `manual`.
--   * `evidence_kind = 'channel_payment'` and a non-null provider reference are
--     required for online receipts; no staff/actor is fabricated.
--   * `simulated` is only legal on online payment rows and is stored on the
--     immutable fact itself so formal summaries can exclude Mock exactly.
--
-- No existing order, receipt, batch, statement, settlement or reward row is
-- rewritten. Foreign-key enforcement is disabled by createDatabase for rebuild
-- migrations and checked again before the connection is handed out.
PRAGMA legacy_alter_table=ON;
--> statement-breakpoint
CREATE TABLE `ledger_entries_new` (
	`id` text PRIMARY KEY NOT NULL,
	`fact_kind` text NOT NULL,
	`source_system` text NOT NULL,
	`simulated` integer NOT NULL DEFAULT 0,
	`source_id` text NOT NULL,
	`source_display_no` text NOT NULL,
	`community_id` text NOT NULL,
	`product_id` text,
	`attributed_staff_id` text,
	`attribution_state` text NOT NULL,
	`attribution_basis` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`settlement_amount_status` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`verified_at` integer,
	`recorded_by_user_id` text,
	`recorded_by_staff_id` text,
	`counter_entry_id` text,
	`evidence_ref` text,
	`evidence_kind` text NOT NULL,
	`batch_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`product_id`) REFERENCES `local_products`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`attributed_staff_id`) REFERENCES `staff_accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`recorded_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`recorded_by_staff_id`) REFERENCES `staff_accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`counter_entry_id`) REFERENCES `ledger_entries`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`batch_id`) REFERENCES `reconciliation_batches`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ledger_entries_fact_kind_check" CHECK("fact_kind" IN ('order_registered', 'order_verified', 'payment_received',
        'payment_reversed', 'reward_cost', 'reward_reversed')),
	CONSTRAINT "ledger_entries_source_system_check" CHECK("source_system" IN ('local_order', 'crm_service_order', 'activity_reward_grant',
        'manual', 'online_payment')),
	CONSTRAINT "ledger_entries_source_kind_check" CHECK(("fact_kind" = 'order_registered' AND "source_system" = 'local_order')
        OR ("fact_kind" = 'order_verified'
          AND "source_system" IN ('local_order', 'crm_service_order'))
        OR ("fact_kind" = 'payment_received'
          AND "source_system" IN ('manual', 'online_payment'))
        OR ("fact_kind" = 'payment_reversed' AND "source_system" = 'manual')
        OR ("fact_kind" IN ('reward_cost', 'reward_reversed')
          AND "source_system" = 'activity_reward_grant')),
	CONSTRAINT "ledger_entries_attribution_state_check" CHECK("attribution_state" IN ('attributed', 'pending')),
	CONSTRAINT "ledger_entries_attribution_basis_check" CHECK("attribution_basis" IN ('explicit_attribution', 'confirmed_fact',
        'no_explicit_attribution', 'source_missing')),
	CONSTRAINT "ledger_entries_attribution_check" CHECK(("attribution_state" = 'attributed'
          AND "attributed_staff_id" IS NOT NULL
          AND "attribution_basis" IN ('explicit_attribution', 'confirmed_fact'))
        OR ("attribution_state" = 'pending'
          AND "attributed_staff_id" IS NULL
          AND "attribution_basis" IN ('no_explicit_attribution', 'source_missing'))),
	CONSTRAINT "ledger_entries_amount_check" CHECK("amount_cents" >= 0),
	CONSTRAINT "ledger_entries_settlement_status_check" CHECK("settlement_amount_status" IN ('pending_rule', 'estimated')),
	CONSTRAINT "ledger_entries_evidence_kind_check" CHECK("evidence_kind" IN ('manual_receipt', 'bank_transfer', 'crm_confirmation',
        'order_verification', 'reward_grant', 'channel_payment', 'none')),
	CONSTRAINT "ledger_entries_payment_evidence_check" CHECK("fact_kind" NOT IN ('payment_received', 'payment_reversed')
        OR ("fact_kind" = 'payment_received'
          AND "source_system" = 'online_payment'
          AND "evidence_ref" IS NOT NULL
          AND "recorded_by_user_id" IS NULL
          AND "recorded_by_staff_id" IS NULL
          AND "evidence_kind" = 'channel_payment')
        OR ("source_system" = 'manual'
          AND "evidence_ref" IS NOT NULL
          AND "recorded_by_staff_id" IS NOT NULL
          AND "evidence_kind" IN ('manual_receipt', 'bank_transfer')
          AND "simulated" = 0)),
	CONSTRAINT "ledger_entries_simulated_check" CHECK("simulated" IN (0, 1)
        AND ("simulated" = 0 OR "source_system" = 'online_payment')),
	CONSTRAINT "ledger_entries_counter_entry_check" CHECK(("fact_kind" IN ('payment_reversed', 'reward_reversed')
          AND "counter_entry_id" IS NOT NULL)
        OR ("fact_kind" NOT IN ('payment_reversed', 'reward_reversed')
          AND "counter_entry_id" IS NULL)),
	CONSTRAINT "ledger_entries_verified_at_check" CHECK(("fact_kind" = 'order_verified' AND "verified_at" IS NOT NULL)
        OR ("fact_kind" <> 'order_verified' AND "verified_at" IS NULL))
);
--> statement-breakpoint
INSERT INTO `ledger_entries_new`
  (`id`, `fact_kind`, `source_system`, `simulated`, `source_id`, `source_display_no`,
   `community_id`, `product_id`, `attributed_staff_id`, `attribution_state`,
   `attribution_basis`, `amount_cents`, `settlement_amount_status`, `occurred_at`,
   `verified_at`, `recorded_by_user_id`, `recorded_by_staff_id`, `counter_entry_id`,
   `evidence_ref`, `evidence_kind`, `batch_id`, `created_at`)
SELECT
  `id`, `fact_kind`, `source_system`, 0, `source_id`, `source_display_no`,
  `community_id`, `product_id`, `attributed_staff_id`, `attribution_state`,
  `attribution_basis`, `amount_cents`, `settlement_amount_status`, `occurred_at`,
  `verified_at`, `recorded_by_user_id`, `recorded_by_staff_id`, `counter_entry_id`,
  `evidence_ref`, `evidence_kind`, `batch_id`, `created_at`
FROM `ledger_entries`;
--> statement-breakpoint
DROP TABLE `ledger_entries`;
--> statement-breakpoint
ALTER TABLE `ledger_entries_new` RENAME TO `ledger_entries`;
--> statement-breakpoint
CREATE INDEX `ledger_entries_community_occurred_idx` ON `ledger_entries` (`community_id`,`occurred_at`);
--> statement-breakpoint
CREATE INDEX `ledger_entries_attributed_occurred_idx` ON `ledger_entries` (`attributed_staff_id`,`occurred_at`);
--> statement-breakpoint
CREATE INDEX `ledger_entries_fact_kind_occurred_idx` ON `ledger_entries` (`fact_kind`,`occurred_at`);
--> statement-breakpoint
CREATE INDEX `ledger_entries_batch_idx` ON `ledger_entries` (`batch_id`);
--> statement-breakpoint
CREATE INDEX `ledger_entries_source_idx` ON `ledger_entries` (`source_system`,`source_id`);
--> statement-breakpoint
CREATE INDEX `ledger_entries_product_idx` ON `ledger_entries` (`product_id`);
--> statement-breakpoint
CREATE INDEX `ledger_entries_simulated_fact_idx` ON `ledger_entries` (`simulated`,`fact_kind`,`occurred_at`);
--> statement-breakpoint
CREATE TABLE `ledger_entry_sources_new` (
	`id` text PRIMARY KEY NOT NULL,
	`source_system` text NOT NULL,
	`source_id` text NOT NULL,
	`fact_kind` text NOT NULL,
	`entry_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `ledger_entries`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ledger_entry_sources_fact_kind_check" CHECK("fact_kind" IN ('order_registered', 'order_verified', 'payment_received',
        'payment_reversed', 'reward_cost', 'reward_reversed')),
	CONSTRAINT "ledger_entry_sources_source_system_check" CHECK("source_system" IN ('local_order', 'crm_service_order', 'activity_reward_grant',
        'manual', 'online_payment'))
);
--> statement-breakpoint
INSERT INTO `ledger_entry_sources_new`
  (`id`, `source_system`, `source_id`, `fact_kind`, `entry_id`, `created_at`)
SELECT
  `id`, `source_system`, `source_id`, `fact_kind`, `entry_id`, `created_at`
FROM `ledger_entry_sources`;
--> statement-breakpoint
DROP TABLE `ledger_entry_sources`;
--> statement-breakpoint
ALTER TABLE `ledger_entry_sources_new` RENAME TO `ledger_entry_sources`;
--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_entry_sources_dedupe_uq` ON `ledger_entry_sources` (`source_system`,`source_id`,`fact_kind`);
--> statement-breakpoint
CREATE INDEX `ledger_entry_sources_entry_idx` ON `ledger_entry_sources` (`entry_id`);
--> statement-breakpoint
CREATE TRIGGER `ledger_entries_no_update`
BEFORE UPDATE ON `ledger_entries`
BEGIN
	SELECT RAISE(ABORT, 'ledger_entries rows are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `ledger_entries_no_delete`
BEFORE DELETE ON `ledger_entries`
BEGIN
	SELECT RAISE(ABORT, 'ledger_entries rows are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `ledger_entries_counter_entry_scope`
BEFORE INSERT ON `ledger_entries`
WHEN NEW.`counter_entry_id` IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'a reversal must point at a forward entry of the same community')
	WHERE NOT EXISTS (
		SELECT 1 FROM `ledger_entries` e
		WHERE e.`id` = NEW.`counter_entry_id`
			AND e.`id` <> NEW.`id`
			AND e.`community_id` = NEW.`community_id`
			AND (
				(NEW.`fact_kind` = 'payment_reversed' AND e.`fact_kind` = 'payment_received')
				OR (NEW.`fact_kind` = 'reward_reversed' AND e.`fact_kind` = 'reward_cost')
			)
	);
END;
--> statement-breakpoint
CREATE TRIGGER `ledger_entry_sources_no_update`
BEFORE UPDATE ON `ledger_entry_sources`
BEGIN
	SELECT RAISE(ABORT, 'ledger_entry_sources dedupe keys are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `ledger_entry_sources_no_delete`
BEFORE DELETE ON `ledger_entry_sources`
BEGIN
	SELECT RAISE(ABORT, 'ledger_entry_sources dedupe keys are immutable');
END;
--> statement-breakpoint
PRAGMA legacy_alter_table=OFF;
