CREATE TABLE `ledger_anomalies` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`kind` text NOT NULL,
	`severity` text NOT NULL,
	`note` text,
	`flagged_by_user_id` text,
	`resolved_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `ledger_entries`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`flagged_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ledger_anomalies_kind_check" CHECK("ledger_anomalies"."kind" IN ('amount_mismatch', 'attribution_conflict',
        'source_missing_evidence', 'duplicate_candidate', 'period_gap')),
	CONSTRAINT "ledger_anomalies_severity_check" CHECK("ledger_anomalies"."severity" IN ('low', 'medium', 'high'))
);
--> statement-breakpoint
CREATE INDEX `ledger_anomalies_entry_idx` ON `ledger_anomalies` (`entry_id`);--> statement-breakpoint
CREATE INDEX `ledger_anomalies_open_idx` ON `ledger_anomalies` (`resolved_at`,`severity`);--> statement-breakpoint
CREATE TABLE `ledger_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`fact_kind` text NOT NULL,
	`source_system` text NOT NULL,
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
	CONSTRAINT "ledger_entries_fact_kind_check" CHECK("ledger_entries"."fact_kind" IN ('order_registered', 'order_verified', 'payment_received',
        'payment_reversed', 'reward_cost', 'reward_reversed')),
	CONSTRAINT "ledger_entries_source_system_check" CHECK("ledger_entries"."source_system" IN ('local_order', 'crm_service_order', 'activity_reward_grant', 'manual')),
	CONSTRAINT "ledger_entries_source_kind_check" CHECK(("ledger_entries"."fact_kind" = 'order_registered' AND "ledger_entries"."source_system" = 'local_order')
        OR ("ledger_entries"."fact_kind" = 'order_verified'
          AND "ledger_entries"."source_system" IN ('local_order', 'crm_service_order'))
        OR ("ledger_entries"."fact_kind" IN ('payment_received', 'payment_reversed')
          AND "ledger_entries"."source_system" = 'manual')
        OR ("ledger_entries"."fact_kind" IN ('reward_cost', 'reward_reversed')
          AND "ledger_entries"."source_system" = 'activity_reward_grant')),
	CONSTRAINT "ledger_entries_attribution_state_check" CHECK("ledger_entries"."attribution_state" IN ('attributed', 'pending')),
	CONSTRAINT "ledger_entries_attribution_basis_check" CHECK("ledger_entries"."attribution_basis" IN ('explicit_attribution', 'confirmed_fact',
        'no_explicit_attribution', 'source_missing')),
	CONSTRAINT "ledger_entries_attribution_check" CHECK(("ledger_entries"."attribution_state" = 'attributed'
          AND "ledger_entries"."attributed_staff_id" IS NOT NULL
          AND "ledger_entries"."attribution_basis" IN ('explicit_attribution', 'confirmed_fact'))
        OR ("ledger_entries"."attribution_state" = 'pending'
          AND "ledger_entries"."attributed_staff_id" IS NULL
          AND "ledger_entries"."attribution_basis" IN ('no_explicit_attribution', 'source_missing'))),
	CONSTRAINT "ledger_entries_amount_check" CHECK("ledger_entries"."amount_cents" >= 0),
	CONSTRAINT "ledger_entries_settlement_status_check" CHECK("ledger_entries"."settlement_amount_status" IN ('pending_rule', 'estimated')),
	CONSTRAINT "ledger_entries_evidence_kind_check" CHECK("ledger_entries"."evidence_kind" IN ('manual_receipt', 'bank_transfer', 'crm_confirmation',
        'order_verification', 'reward_grant', 'none')),
	CONSTRAINT "ledger_entries_payment_evidence_check" CHECK("ledger_entries"."fact_kind" NOT IN ('payment_received', 'payment_reversed')
        OR ("ledger_entries"."evidence_ref" IS NOT NULL
          AND "ledger_entries"."recorded_by_staff_id" IS NOT NULL
          AND "ledger_entries"."evidence_kind" <> 'none')),
	CONSTRAINT "ledger_entries_counter_entry_check" CHECK(("ledger_entries"."fact_kind" IN ('payment_reversed', 'reward_reversed')
          AND "ledger_entries"."counter_entry_id" IS NOT NULL)
        OR ("ledger_entries"."fact_kind" NOT IN ('payment_reversed', 'reward_reversed')
          AND "ledger_entries"."counter_entry_id" IS NULL)),
	CONSTRAINT "ledger_entries_verified_at_check" CHECK(("ledger_entries"."fact_kind" = 'order_verified' AND "ledger_entries"."verified_at" IS NOT NULL)
        OR ("ledger_entries"."fact_kind" <> 'order_verified' AND "ledger_entries"."verified_at" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `ledger_entries_community_occurred_idx` ON `ledger_entries` (`community_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `ledger_entries_attributed_occurred_idx` ON `ledger_entries` (`attributed_staff_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `ledger_entries_fact_kind_occurred_idx` ON `ledger_entries` (`fact_kind`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `ledger_entries_batch_idx` ON `ledger_entries` (`batch_id`);--> statement-breakpoint
CREATE INDEX `ledger_entries_source_idx` ON `ledger_entries` (`source_system`,`source_id`);--> statement-breakpoint
CREATE INDEX `ledger_entries_product_idx` ON `ledger_entries` (`product_id`);--> statement-breakpoint
CREATE TABLE `ledger_entry_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`source_system` text NOT NULL,
	`source_id` text NOT NULL,
	`fact_kind` text NOT NULL,
	`entry_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `ledger_entries`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ledger_entry_sources_fact_kind_check" CHECK("ledger_entry_sources"."fact_kind" IN ('order_registered', 'order_verified', 'payment_received',
        'payment_reversed', 'reward_cost', 'reward_reversed')),
	CONSTRAINT "ledger_entry_sources_source_system_check" CHECK("ledger_entry_sources"."source_system" IN ('local_order', 'crm_service_order', 'activity_reward_grant', 'manual'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_entry_sources_dedupe_uq` ON `ledger_entry_sources` (`source_system`,`source_id`,`fact_kind`);--> statement-breakpoint
CREATE INDEX `ledger_entry_sources_entry_idx` ON `ledger_entry_sources` (`entry_id`);--> statement-breakpoint
CREATE TABLE `reconciliation_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_no` text NOT NULL,
	`period_from` text NOT NULL,
	`period_to` text NOT NULL,
	`status` text NOT NULL,
	`locked_at` integer,
	`locked_by_user_id` text,
	`locked_by_staff_id` text,
	`entry_count` integer NOT NULL,
	`total_cents` integer NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`locked_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`locked_by_staff_id`) REFERENCES `staff_accounts`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "reconciliation_batches_status_check" CHECK("reconciliation_batches"."status" IN ('open', 'locked')),
	CONSTRAINT "reconciliation_batches_period_check" CHECK("reconciliation_batches"."period_from" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        AND "reconciliation_batches"."period_to" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        AND "reconciliation_batches"."period_to" >= "reconciliation_batches"."period_from"),
	CONSTRAINT "reconciliation_batches_counts_check" CHECK("reconciliation_batches"."entry_count" >= 0 AND "reconciliation_batches"."total_cents" >= 0),
	CONSTRAINT "reconciliation_batches_lock_check" CHECK(("reconciliation_batches"."status" = 'locked'
          AND "reconciliation_batches"."locked_at" IS NOT NULL
          AND "reconciliation_batches"."locked_by_user_id" IS NOT NULL)
        OR ("reconciliation_batches"."status" = 'open'
          AND "reconciliation_batches"."locked_at" IS NULL
          AND "reconciliation_batches"."locked_by_user_id" IS NULL
          AND "reconciliation_batches"."locked_by_staff_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reconciliation_batches_no_uq` ON `reconciliation_batches` (`batch_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `reconciliation_batches_open_period_uq` ON `reconciliation_batches` (`period_from`,`period_to`) WHERE "reconciliation_batches"."status" = 'open';--> statement-breakpoint
CREATE INDEX `reconciliation_batches_period_idx` ON `reconciliation_batches` (`period_from`,`period_to`);--> statement-breakpoint
CREATE INDEX `reconciliation_batches_status_updated_idx` ON `reconciliation_batches` (`status`,`updated_at`);--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Hand-written constraint layer (LL-MVP-008, Issue #64).
--
-- drizzle-kit generated everything above from `src/db/schema.ts`. The triggers
-- below exist because "append-only" and "one-way lock" are cross-row semantics
-- that neither Drizzle nor a column CHECK can express. Object names are stable
-- so a later `drizzle-kit generate` stays a no-op and tests can assert them.
--
-- Boundaries encoded here on disk:
--   * `ledger_entries` rows are facts: UPDATE and DELETE are impossible, so a
--     correction can only ever be a new reversal row (`counter_entry_id`).
--     This is what makes a printed reconciliation statement reproducible.
--     Reconciliation membership is therefore *derived* from the batch period,
--     never stamped onto the fact row by an update.
--   * A reversal must point at a real, same-community entry of the opposite
--     kind; pointing at nothing (or at another reversal) is rejected.
--   * The dedupe rows in `ledger_entry_sources` never change either: a replayed
--     source notification can only hit the existing entry.
--   * `ledger_anomalies` are history: they may be resolved (UPDATE), never
--     deleted.
--   * `reconciliation_batches` may only move `open -> locked`, exactly once.
--     Batch identity (batch_no / period) is frozen at creation, and a locked
--     batch is fully immutable — its entry_count / total_cents can no longer
--     drift after the statement was issued.
-- ---------------------------------------------------------------------------

CREATE TRIGGER `ledger_entries_no_update`
BEFORE UPDATE ON `ledger_entries`
BEGIN
	SELECT RAISE(ABORT, 'ledger_entries rows are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `ledger_entries_no_delete`
BEFORE DELETE ON `ledger_entries`
BEGIN
	SELECT RAISE(ABORT, 'ledger_entries rows are immutable');
END;--> statement-breakpoint
-- A reversal names the entry it reverses. It must be a different, existing row
-- in the same community with the matching forward fact kind, otherwise a pair
-- could "reverse" a fact from another community or build a chain of reversals.
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
END;--> statement-breakpoint
CREATE TRIGGER `ledger_entry_sources_no_update`
BEFORE UPDATE ON `ledger_entry_sources`
BEGIN
	SELECT RAISE(ABORT, 'ledger_entry_sources dedupe keys are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `ledger_entry_sources_no_delete`
BEFORE DELETE ON `ledger_entry_sources`
BEGIN
	SELECT RAISE(ABORT, 'ledger_entry_sources dedupe keys are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `ledger_anomalies_no_delete`
BEFORE DELETE ON `ledger_anomalies`
BEGIN
	SELECT RAISE(ABORT, 'ledger_anomalies rows are append-only history');
END;--> statement-breakpoint
-- Batch identity is frozen at creation: re-dating a batch would silently move
-- facts into another reconciliation period.
CREATE TRIGGER `reconciliation_batches_identity_immutable`
BEFORE UPDATE OF `id`, `batch_no`, `period_from`, `period_to`, `created_at` ON `reconciliation_batches`
BEGIN
	SELECT RAISE(ABORT, 'reconciliation_batches identity and period are frozen at creation');
END;--> statement-breakpoint
-- `open -> locked` is the only transition, and it happens exactly once. The
-- same statement may fill entry_count / total_cents / lock stamps.
CREATE TRIGGER `reconciliation_batches_status_transition`
BEFORE UPDATE OF `status` ON `reconciliation_batches`
WHEN NOT (OLD.`status` = 'open' AND NEW.`status` = 'locked')
BEGIN
	SELECT RAISE(ABORT, 'reconciliation_batches may only move from open to locked');
END;--> statement-breakpoint
-- Once locked, nothing about the batch may change again: the period it covers
-- and the totals it reported are the frozen basis of the statement.
CREATE TRIGGER `reconciliation_batches_locked_immutable`
BEFORE UPDATE ON `reconciliation_batches`
WHEN OLD.`status` = 'locked'
BEGIN
	SELECT RAISE(ABORT, 'reconciliation_batches rows are immutable once locked');
END;--> statement-breakpoint
CREATE TRIGGER `reconciliation_batches_no_delete`
BEFORE DELETE ON `reconciliation_batches`
BEGIN
	SELECT RAISE(ABORT, 'reconciliation_batches rows are append-only history');
END;
