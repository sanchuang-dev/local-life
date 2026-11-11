-- LL-IDENTITY-001 (#171): one permanent community per resident, confirmed by the
-- resident themself. Additive only; safe on a database that already holds data.
--
-- What this migration deliberately does NOT do:
--   * `resident_community_assignments` is untouched: no column, constraint or row
--     is changed or deleted, so every historical relation survives — including the
--     rows the retired #123 OAuth flow inserted automatically at login. Those rows
--     keep meaning "a relation was observed", never "the resident confirmed it".
--   * nothing is copied into the new tables. A legacy single relation is exposed
--     read-only as a candidate the resident must confirm; two or more relations are
--     reported as `pending_review` for a human. No earliest/newest row is picked
--     and no legacy row is promoted to a permanent binding.
--   * no order / CRM / reward / ledger / reconciliation row is read or written.
--
-- The invariant "at most one confirmed community per resident" is enforced here,
-- in the database, in two independent layers:
--   1. `resident_community_bindings_user_confirmed_uq` is a PARTIAL UNIQUE index on
--      (user_id) WHERE status = 'confirmed';
--   2. `resident_community_bindings_status_check` admits `status = 'confirmed'`
--      only, so the partial index covers every row.
-- A direct `INSERT` that bypasses the API is therefore rejected by SQLite itself,
-- which is asserted by `apps/api/test/resident-community-db.test.ts`.
--
-- Rollback (data-preserving; take a backup and record the affected
-- user_id/community_id pairs of `resident_community_bindings` first, because
-- dropping it discards confirmed facts that the residents would have to repeat):
--   DROP INDEX IF EXISTS `resident_community_bindings_community_idx`;
--   DROP INDEX IF EXISTS `resident_community_bindings_user_confirmed_uq`;
--   DROP TABLE IF EXISTS `resident_community_bindings`;
--   DROP INDEX IF EXISTS `resident_community_candidates_community_idx`;
--   DROP TABLE IF EXISTS `resident_community_binding_candidates`;
-- No pre-existing table is restored, because none was modified.
--
-- Pre-flight (read-only) statistics against the target database, so the operator
-- knows how many accounts land in each state before deploying:
--   SELECT COUNT(*) FROM resident_community_assignments;              -- preserved
--   SELECT COUNT(*) FROM (SELECT user_id FROM resident_community_assignments
--     GROUP BY user_id HAVING COUNT(*) > 1);                          -- pending_review
CREATE TABLE `resident_community_binding_candidates` (
	`user_id` text PRIMARY KEY NOT NULL,
	`community_id` text NOT NULL,
	`source` text NOT NULL,
	`suggested_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "resident_community_candidates_source_check" CHECK("resident_community_binding_candidates"."source" IN ('activity_oauth_candidate')),
	CONSTRAINT "resident_community_candidates_expiry_check" CHECK("resident_community_binding_candidates"."expires_at" > "resident_community_binding_candidates"."suggested_at")
);
--> statement-breakpoint
CREATE INDEX `resident_community_candidates_community_idx` ON `resident_community_binding_candidates` (`community_id`);--> statement-breakpoint
CREATE TABLE `resident_community_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`community_id` text NOT NULL,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`confirmed_at` integer NOT NULL,
	`source` text NOT NULL,
	`confirmed_by_user_id` text,
	`evidence_ref` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`confirmed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "resident_community_bindings_status_check" CHECK("resident_community_bindings"."status" = 'confirmed'),
	CONSTRAINT "resident_community_bindings_source_check" CHECK("resident_community_bindings"."source" IN ('resident_h5_confirmed', 'admin_compliance_correction')),
	CONSTRAINT "resident_community_bindings_evidence_check" CHECK(length("resident_community_bindings"."evidence_ref") > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `resident_community_bindings_user_confirmed_uq` ON `resident_community_bindings` (`user_id`) WHERE "resident_community_bindings"."status" = 'confirmed';--> statement-breakpoint
CREATE INDEX `resident_community_bindings_community_idx` ON `resident_community_bindings` (`community_id`);