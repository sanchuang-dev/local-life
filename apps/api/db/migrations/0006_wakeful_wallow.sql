-- NOTE ON REVISION (unique keys of the reward ledger)
-- This migration is new in this PR and was never merged, so it may be edited in
-- place. Drizzle's migrator, however, decides purely by journal timestamp and
-- does NOT compare SQL text: a local database that already applied an earlier
-- revision of 0006 will NOT re-run it, and would silently keep the old
-- version-scoped unique indexes — i.e. keep double-issuing prizes.
-- If you have such a database, either delete it and let it rebuild, or run the
-- equivalent by hand:
--   DROP INDEX IF EXISTS `activity_reward_grants_activity_version_team_uq`;
--   DROP INDEX IF EXISTS `activity_prize_stocks_activity_version_prize_uq`;
--   ...then recreate the two indexes defined further down in this file.
-- If the affected database already holds several stock rows for one activity and
-- prize name (only possible under the old version-scoped key), merge them into a
-- single row FIRST: summing `claimed_quantity` / `redeemed_quantity`, keeping the
-- earliest `unit_cost_cents` / `budget_cap_cents`, and recomputing the committed
-- and redeemed budget totals to match — otherwise the new unique index cannot be
-- created at all.

CREATE TABLE `activity_checkins` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`user_id` text NOT NULL,
	`team_id` text,
	`seat_no` integer,
	`status` text NOT NULL,
	`note` text,
	`checked_in_at` integer NOT NULL,
	`verified_at` integer,
	`verified_by_staff_id` text,
	`revoked_at` integer,
	`revoked_by_staff_id` text,
	`revoke_reason` text,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`team_id`) REFERENCES `activity_teams`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`verified_by_staff_id`) REFERENCES `staff_accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`revoked_by_staff_id`) REFERENCES `staff_accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "activity_checkins_status_check" CHECK("activity_checkins"."status" IN ('valid', 'revoked')),
	CONSTRAINT "activity_checkins_seat_no_check" CHECK(("activity_checkins"."team_id" IS NULL AND "activity_checkins"."seat_no" IS NULL)
        OR ("activity_checkins"."team_id" IS NOT NULL AND "activity_checkins"."seat_no" BETWEEN 1 AND 3)),
	CONSTRAINT "activity_checkins_revocation_check" CHECK(("activity_checkins"."status" = 'revoked'
          AND "activity_checkins"."revoked_at" IS NOT NULL
          AND "activity_checkins"."revoked_by_staff_id" IS NOT NULL
          AND "activity_checkins"."revoke_reason" IS NOT NULL
          AND length(trim("activity_checkins"."revoke_reason")) >= 2)
        OR ("activity_checkins"."status" = 'valid'
          AND "activity_checkins"."revoked_at" IS NULL
          AND "activity_checkins"."revoked_by_staff_id" IS NULL
          AND "activity_checkins"."revoke_reason" IS NULL)),
	CONSTRAINT "activity_checkins_verification_check" CHECK(("activity_checkins"."verified_at" IS NULL AND "activity_checkins"."verified_by_staff_id" IS NULL)
        OR ("activity_checkins"."verified_at" IS NOT NULL AND "activity_checkins"."verified_by_staff_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activity_checkins_activity_user_valid_uq` ON `activity_checkins` (`activity_id`,`user_id`) WHERE "activity_checkins"."status" = 'valid';--> statement-breakpoint
CREATE INDEX `activity_checkins_activity_status_idx` ON `activity_checkins` (`activity_id`,`status`);--> statement-breakpoint
CREATE INDEX `activity_checkins_user_idx` ON `activity_checkins` (`user_id`);--> statement-breakpoint
CREATE INDEX `activity_checkins_team_idx` ON `activity_checkins` (`team_id`);--> statement-breakpoint
CREATE TABLE `activity_prize_stocks` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`rule_version_id` text NOT NULL,
	`prize_name` text NOT NULL,
	`unit_cost_cents` integer NOT NULL,
	`total_quantity` integer NOT NULL,
	`claimed_quantity` integer DEFAULT 0 NOT NULL,
	`redeemed_quantity` integer DEFAULT 0 NOT NULL,
	`budget_cap_cents` integer NOT NULL,
	`committed_budget_cents` integer DEFAULT 0 NOT NULL,
	`redeemed_budget_cents` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`rule_version_id`) REFERENCES `activity_rule_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "activity_prize_stocks_unit_cost_check" CHECK("activity_prize_stocks"."unit_cost_cents" > 0 AND "activity_prize_stocks"."total_quantity" > 0 AND "activity_prize_stocks"."budget_cap_cents" > 0),
	CONSTRAINT "activity_prize_stocks_quantity_check" CHECK("activity_prize_stocks"."claimed_quantity" >= 0
        AND "activity_prize_stocks"."redeemed_quantity" >= 0
        AND "activity_prize_stocks"."claimed_quantity" <= "activity_prize_stocks"."total_quantity"
        AND "activity_prize_stocks"."redeemed_quantity" <= "activity_prize_stocks"."claimed_quantity"),
	CONSTRAINT "activity_prize_stocks_budget_check" CHECK("activity_prize_stocks"."committed_budget_cents" = "activity_prize_stocks"."claimed_quantity" * "activity_prize_stocks"."unit_cost_cents"
        AND "activity_prize_stocks"."redeemed_budget_cents" = "activity_prize_stocks"."redeemed_quantity" * "activity_prize_stocks"."unit_cost_cents"
        AND "activity_prize_stocks"."committed_budget_cents" <= "activity_prize_stocks"."budget_cap_cents")
);
--> statement-breakpoint
-- One prize ledger per activity and prize name, NOT per rule version. A rule
-- edit bumps `activity_rule_versions`, so a version-scoped ledger would let each
-- new version start a fresh `claimed_quantity = 0` and silently multiply
-- `total_prize_quantity` / `budget_cap_cents` by the number of edits. The single
-- row keeps the whole activity's stock and budget in one place; `rule_version_id`
-- survives on the row only as the provenance of the prices it was created from.
CREATE UNIQUE INDEX `activity_prize_stocks_activity_prize_uq` ON `activity_prize_stocks` (`activity_id`,`prize_name`);--> statement-breakpoint
CREATE INDEX `activity_prize_stocks_activity_idx` ON `activity_prize_stocks` (`activity_id`);--> statement-breakpoint
CREATE TABLE `activity_reward_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`activity_id` text NOT NULL,
	`team_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`code_suffix` text NOT NULL,
	`prize_name` text NOT NULL,
	`status` text NOT NULL,
	`issued_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`redeemed_at` integer,
	`redeemed_by_staff_id` text,
	`superseded_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`grant_id`) REFERENCES `activity_reward_grants`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`team_id`) REFERENCES `activity_teams`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`redeemed_by_staff_id`) REFERENCES `staff_accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "activity_reward_codes_status_check" CHECK("activity_reward_codes"."status" IN ('active', 'redeemed', 'superseded', 'expired', 'revoked')),
	CONSTRAINT "activity_reward_codes_hash_check" CHECK(length("activity_reward_codes"."code_hash") = 64 AND "activity_reward_codes"."code_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "activity_reward_codes_suffix_check" CHECK(length("activity_reward_codes"."code_suffix") = 4 AND "activity_reward_codes"."code_suffix" NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
	CONSTRAINT "activity_reward_codes_expiry_check" CHECK("activity_reward_codes"."expires_at" > "activity_reward_codes"."issued_at"),
	CONSTRAINT "activity_reward_codes_redemption_check" CHECK(("activity_reward_codes"."status" = 'redeemed'
          AND "activity_reward_codes"."redeemed_at" IS NOT NULL
          AND "activity_reward_codes"."redeemed_by_staff_id" IS NOT NULL)
        OR ("activity_reward_codes"."status" <> 'redeemed'
          AND "activity_reward_codes"."redeemed_at" IS NULL
          AND "activity_reward_codes"."redeemed_by_staff_id" IS NULL)),
	CONSTRAINT "activity_reward_codes_superseded_check" CHECK(("activity_reward_codes"."status" = 'superseded' AND "activity_reward_codes"."superseded_at" IS NOT NULL)
        OR ("activity_reward_codes"."status" <> 'superseded' AND "activity_reward_codes"."superseded_at" IS NULL)),
	CONSTRAINT "activity_reward_codes_revoked_check" CHECK(("activity_reward_codes"."status" = 'revoked' AND "activity_reward_codes"."revoked_at" IS NOT NULL)
        OR ("activity_reward_codes"."status" <> 'revoked' AND "activity_reward_codes"."revoked_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activity_reward_codes_hash_uq` ON `activity_reward_codes` (`code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `activity_reward_codes_grant_active_uq` ON `activity_reward_codes` (`grant_id`) WHERE "activity_reward_codes"."status" = 'active';--> statement-breakpoint
CREATE INDEX `activity_reward_codes_activity_status_idx` ON `activity_reward_codes` (`activity_id`,`status`);--> statement-breakpoint
CREATE INDEX `activity_reward_codes_grant_idx` ON `activity_reward_codes` (`grant_id`);--> statement-breakpoint
CREATE TABLE `activity_reward_disputes` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`grant_id` text NOT NULL,
	`decision` text NOT NULL,
	`reason` text NOT NULL,
	`note` text,
	`actor_staff_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`grant_id`) REFERENCES `activity_reward_grants`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`actor_staff_id`) REFERENCES `staff_accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "activity_reward_disputes_decision_check" CHECK("activity_reward_disputes"."decision" IN ('opened', 'reversed', 'dismissed')),
	CONSTRAINT "activity_reward_disputes_reason_check" CHECK(length(trim("activity_reward_disputes"."reason")) >= 2)
);
--> statement-breakpoint
CREATE INDEX `activity_reward_disputes_grant_created_idx` ON `activity_reward_disputes` (`grant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `activity_reward_disputes_activity_idx` ON `activity_reward_disputes` (`activity_id`);--> statement-breakpoint
CREATE TABLE `activity_reward_events` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`kind` text NOT NULL,
	`grant_id` text,
	`checkin_id` text,
	`credential_id` text,
	`actor_user_id` text,
	`actor_staff_id` text,
	`detail_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`grant_id`) REFERENCES `activity_reward_grants`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`checkin_id`) REFERENCES `activity_checkins`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`credential_id`) REFERENCES `activity_reward_codes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`actor_staff_id`) REFERENCES `staff_accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "activity_reward_events_sequence_check" CHECK("activity_reward_events"."sequence" > 0),
	CONSTRAINT "activity_reward_events_kind_check" CHECK("activity_reward_events"."kind" IN ('checkin.verified', 'checkin.revoked', 'grant.created', 'grant.redeemed', 'grant.revoked', 'grant.expired', 'credential.issued', 'credential.superseded', 'dispute.opened', 'dispute.reversed', 'dispute.dismissed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activity_reward_events_activity_sequence_uq` ON `activity_reward_events` (`activity_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `activity_reward_events_activity_created_idx` ON `activity_reward_events` (`activity_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `activity_reward_events_grant_idx` ON `activity_reward_events` (`grant_id`);--> statement-breakpoint
CREATE INDEX `activity_reward_events_kind_idx` ON `activity_reward_events` (`kind`);--> statement-breakpoint
CREATE TABLE `activity_reward_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`rule_version_id` text NOT NULL,
	`team_id` text NOT NULL,
	`prize_name` text NOT NULL,
	`quantity` integer NOT NULL,
	`unit_cost_cents` integer NOT NULL,
	`total_cost_cents` integer NOT NULL,
	`status` text NOT NULL,
	`recipient_role` text NOT NULL,
	`recipient_user_id` text,
	`granted_at` integer NOT NULL,
	`redeemed_at` integer,
	`redeemed_by_staff_id` text,
	`revoked_at` integer,
	`revoked_by_staff_id` text,
	`revoke_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`rule_version_id`) REFERENCES `activity_rule_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`team_id`) REFERENCES `activity_teams`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`recipient_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`redeemed_by_staff_id`) REFERENCES `staff_accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`revoked_by_staff_id`) REFERENCES `staff_accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "activity_reward_grants_status_check" CHECK("activity_reward_grants"."status" IN ('granted', 'redeemed', 'revoked', 'expired', 'disputed', 'reversed')),
	CONSTRAINT "activity_reward_grants_quantity_check" CHECK("activity_reward_grants"."quantity" > 0),
	CONSTRAINT "activity_reward_grants_unit_cost_check" CHECK("activity_reward_grants"."unit_cost_cents" > 0),
	CONSTRAINT "activity_reward_grants_total_cost_check" CHECK("activity_reward_grants"."total_cost_cents" = "activity_reward_grants"."quantity" * "activity_reward_grants"."unit_cost_cents"),
	CONSTRAINT "activity_reward_grants_recipient_role_check" CHECK("activity_reward_grants"."recipient_role" IN ('leader', 'member')),
	CONSTRAINT "activity_reward_grants_revocation_check" CHECK(("activity_reward_grants"."status" = 'revoked'
          AND "activity_reward_grants"."revoked_at" IS NOT NULL
          AND "activity_reward_grants"."revoked_by_staff_id" IS NOT NULL
          AND "activity_reward_grants"."revoke_reason" IS NOT NULL)
        OR ("activity_reward_grants"."status" <> 'revoked'
          AND "activity_reward_grants"."revoked_at" IS NULL
          AND "activity_reward_grants"."revoked_by_staff_id" IS NULL
          AND "activity_reward_grants"."revoke_reason" IS NULL)),
	CONSTRAINT "activity_reward_grants_redemption_check" CHECK(("activity_reward_grants"."status" IN ('redeemed', 'disputed', 'reversed')
          AND "activity_reward_grants"."redeemed_at" IS NOT NULL
          AND "activity_reward_grants"."redeemed_by_staff_id" IS NOT NULL)
        OR ("activity_reward_grants"."status" IN ('granted', 'revoked', 'expired')
          AND "activity_reward_grants"."redeemed_at" IS NULL
          AND "activity_reward_grants"."redeemed_by_staff_id" IS NULL))
);
--> statement-breakpoint
-- "One team, one activity, one prize" is enforced by the database, not by the
-- claim code. Scoping this to the rule version was the bug: an edit (even just a
-- new `location`) bumps the version, so the same team looked un-granted in the
-- new version and could be handed a second physical prize.
--
-- The index is PARTIAL on `status <> 'revoked'` because revocation is the one
-- transition that legitimately frees the slot: an operator can withdraw an
-- unredeemed grant that turned out to be wrong, and the team must then be able
-- to claim again. Every other status keeps the slot occupied — `granted` and
-- `redeemed` obviously, and also `expired` (the prize was allocated, the code
-- merely lapsed), `disputed` and `reversed` (a redemption already left the
-- stock room, so re-granting would hand out a second physical prize while the
-- first is still being investigated). `rule_version_id` stays NOT NULL as the
-- pricing provenance of the grant and no longer takes part in uniqueness.
CREATE UNIQUE INDEX `activity_reward_grants_activity_team_uq` ON `activity_reward_grants` (`activity_id`,`team_id`) WHERE `activity_reward_grants`.`status` <> 'revoked';--> statement-breakpoint
CREATE INDEX `activity_reward_grants_activity_status_idx` ON `activity_reward_grants` (`activity_id`,`status`);--> statement-breakpoint
CREATE INDEX `activity_reward_grants_team_idx` ON `activity_reward_grants` (`team_id`);--> statement-breakpoint
CREATE INDEX `activity_reward_grants_recipient_idx` ON `activity_reward_grants` (`recipient_user_id`);--> statement-breakpoint
ALTER TABLE `activities` ADD `reward_plan_json` text;
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Hand-written constraint layer (LL-MVP-006, Issue #62).
--
-- drizzle-kit generates the DDL above from `src/db/schema.ts`; everything below
-- is written by hand because SQLite CHECK constraints cannot see other rows or
-- other tables, and because "append-only" and "one-way state machine" are
-- trigger semantics, not column semantics. Object names are stable so a future
-- `drizzle-kit generate` run stays a no-op and existing tests can assert them.
-- ---------------------------------------------------------------------------

-- Check-ins: history is never deleted, identity columns never change, and the
-- only allowed status change is valid -> revoked with a complete revocation
-- stamp. Verification is write-once, so revoking a check-in keeps its evidence.
CREATE TRIGGER `activity_checkins_no_delete`
BEFORE DELETE ON `activity_checkins`
BEGIN
	SELECT RAISE(ABORT, 'activity_checkins rows are append-only history');
END;--> statement-breakpoint
CREATE TRIGGER `activity_checkins_identity_immutable`
BEFORE UPDATE OF `activity_id`, `user_id`, `team_id`, `seat_no`, `checked_in_at` ON `activity_checkins`
BEGIN
	SELECT RAISE(ABORT, 'activity_checkins identity columns are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `activity_checkins_status_transition`
BEFORE UPDATE OF `status` ON `activity_checkins`
WHEN NOT (OLD.`status` = NEW.`status` OR (OLD.`status` = 'valid' AND NEW.`status` = 'revoked'))
BEGIN
	SELECT RAISE(ABORT, 'activity_checkins status may only move from valid to revoked');
END;--> statement-breakpoint
CREATE TRIGGER `activity_checkins_revocation_write_once`
BEFORE UPDATE OF `revoked_at`, `revoked_by_staff_id`, `revoke_reason` ON `activity_checkins`
WHEN NOT (
	OLD.`revoked_at` IS NULL
	AND OLD.`revoked_by_staff_id` IS NULL
	AND OLD.`revoke_reason` IS NULL
	AND OLD.`status` = 'valid'
	AND NEW.`status` = 'revoked'
	AND NEW.`revoked_at` IS NOT NULL
	AND NEW.`revoked_by_staff_id` IS NOT NULL
	AND NEW.`revoke_reason` IS NOT NULL
)
BEGIN
	SELECT RAISE(ABORT, 'activity_checkins revocation is write-once and only while revoking');
END;--> statement-breakpoint
CREATE TRIGGER `activity_checkins_verification_write_once`
BEFORE UPDATE OF `verified_at`, `verified_by_staff_id` ON `activity_checkins`
WHEN NOT (
	OLD.`verified_at` IS NULL
	AND OLD.`verified_by_staff_id` IS NULL
	AND NEW.`verified_at` IS NOT NULL
	AND NEW.`verified_by_staff_id` IS NOT NULL
)
BEGIN
	SELECT RAISE(ABORT, 'activity_checkins verification is write-once and cannot be undone');
END;--> statement-breakpoint
-- A check-in may only name a team that belongs to the same activity.
CREATE TRIGGER `activity_checkins_team_scope`
BEFORE INSERT ON `activity_checkins`
WHEN NEW.`team_id` IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'check-in team must belong to the same activity')
	WHERE NOT EXISTS (
		SELECT 1 FROM `activity_teams` t
		WHERE t.`id` = NEW.`team_id` AND t.`activity_id` = NEW.`activity_id`
	);
END;--> statement-breakpoint
-- A check-in may only be recorded inside the frozen check-in window, never
-- after the activity ended: the window comes from the rule-version snapshot.
CREATE TRIGGER `activity_checkins_window_guard`
BEFORE INSERT ON `activity_checkins`
BEGIN
	SELECT RAISE(ABORT, 'check-in is outside the frozen check-in window')
	WHERE NOT EXISTS (
		SELECT 1
		FROM `activities` a
		JOIN `activity_rule_versions` v ON v.`id` = a.`current_rule_version_id`
		WHERE a.`id` = NEW.`activity_id`
			AND a.`status` = 'published'
			AND json_extract(v.`snapshot_json`, '$.rewardPlan') IS NOT NULL
			-- The frozen window is an ISO string; compare in integer milliseconds
			-- so the guard is exact at second granularity (strftime('%s') floors).
			AND NEW.`checked_in_at` >= strftime('%s', json_extract(v.`snapshot_json`, '$.rewardPlan.checkinWindow.opensAt')) * 1000
			AND NEW.`checked_in_at` < (strftime('%s', json_extract(v.`snapshot_json`, '$.rewardPlan.checkinWindow.closesAt')) + 1) * 1000
	);
END;--> statement-breakpoint

-- Grants: identity and price are frozen at insert, one grant per team and rule
-- version, and the lifecycle is a one-way state machine.
CREATE TRIGGER `activity_reward_grants_no_delete`
BEFORE DELETE ON `activity_reward_grants`
BEGIN
	SELECT RAISE(ABORT, 'activity_reward_grants rows are append-only history');
END;--> statement-breakpoint
CREATE TRIGGER `activity_reward_grants_identity_immutable`
BEFORE UPDATE OF `activity_id`, `rule_version_id`, `team_id`, `prize_name`, `quantity`, `unit_cost_cents`, `total_cost_cents`, `recipient_role`, `recipient_user_id`, `granted_at`, `created_at` ON `activity_reward_grants`
BEGIN
	SELECT RAISE(ABORT, 'activity_reward_grants price and identity are frozen at grant time');
END;--> statement-breakpoint
CREATE TRIGGER `activity_reward_grants_status_transition`
BEFORE UPDATE OF `status` ON `activity_reward_grants`
WHEN NOT (
	OLD.`status` = NEW.`status`
	OR (OLD.`status` = 'granted' AND NEW.`status` IN ('redeemed', 'revoked', 'expired'))
	OR (OLD.`status` = 'redeemed' AND NEW.`status` = 'disputed')
	OR (OLD.`status` = 'disputed' AND NEW.`status` = 'reversed')
)
BEGIN
	SELECT RAISE(ABORT, 'activity_reward_grants status transition is not allowed');
END;--> statement-breakpoint
CREATE TRIGGER `activity_reward_grants_redemption_write_once`
BEFORE UPDATE OF `redeemed_at`, `redeemed_by_staff_id` ON `activity_reward_grants`
WHEN NOT (
	OLD.`redeemed_at` IS NULL
	AND OLD.`redeemed_by_staff_id` IS NULL
	AND OLD.`status` = 'granted'
	AND NEW.`status` = 'redeemed'
	AND NEW.`redeemed_at` IS NOT NULL
	AND NEW.`redeemed_by_staff_id` IS NOT NULL
)
BEGIN
	SELECT RAISE(ABORT, 'activity_reward_grants redemption is write-once and only while redeeming');
END;--> statement-breakpoint
CREATE TRIGGER `activity_reward_grants_revocation_write_once`
BEFORE UPDATE OF `revoked_at`, `revoked_by_staff_id`, `revoke_reason` ON `activity_reward_grants`
WHEN NOT (
	OLD.`revoked_at` IS NULL
	AND OLD.`revoked_by_staff_id` IS NULL
	AND OLD.`revoke_reason` IS NULL
	AND OLD.`status` IN ('granted', 'expired')
	AND NEW.`status` = 'revoked'
	AND NEW.`revoked_at` IS NOT NULL
	AND NEW.`revoked_by_staff_id` IS NOT NULL
	AND NEW.`revoke_reason` IS NOT NULL
)
BEGIN
	SELECT RAISE(ABORT, 'activity_reward_grants revocation is write-once, unredeemed-only and only while revoking');
END;--> statement-breakpoint
-- The grant must be priced by the frozen rule version of its own activity, and
-- the copied numbers must equal the frozen plan. A later edit of the mutable
-- `activities` row can therefore never re-price an issued prize.
CREATE TRIGGER `activity_reward_grants_frozen_plan_guard`
BEFORE INSERT ON `activity_reward_grants`
BEGIN
	SELECT RAISE(ABORT, 'grant must be priced by the frozen reward plan of its activity')
	WHERE NOT EXISTS (
		SELECT 1
		FROM `activity_rule_versions` v
		JOIN `activity_teams` t ON t.`activity_id` = v.`activity_id`
		WHERE v.`id` = NEW.`rule_version_id`
			AND v.`activity_id` = NEW.`activity_id`
			AND t.`id` = NEW.`team_id`
			AND json_extract(v.`snapshot_json`, '$.rewardPlan') IS NOT NULL
			AND NEW.`prize_name` = json_extract(v.`snapshot_json`, '$.rewardPlan.prizeName')
			AND NEW.`unit_cost_cents` = json_extract(v.`snapshot_json`, '$.rewardPlan.prizeUnitCostCents')
			AND NEW.`quantity` = json_extract(v.`snapshot_json`, '$.rewardPlan.prizeQuantityPerTeam')
	);
END;--> statement-breakpoint

-- Credentials: hash-only, one live code per grant, one-way lifecycle.
CREATE TRIGGER `activity_reward_codes_no_delete`
BEFORE DELETE ON `activity_reward_codes`
BEGIN
	SELECT RAISE(ABORT, 'activity_reward_codes rows are append-only history');
END;--> statement-breakpoint
CREATE TRIGGER `activity_reward_codes_identity_immutable`
BEFORE UPDATE OF `grant_id`, `activity_id`, `team_id`, `code_hash`, `code_suffix`, `prize_name`, `issued_at`, `expires_at` ON `activity_reward_codes`
BEGIN
	SELECT RAISE(ABORT, 'activity_reward_codes identity and TTL are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `activity_reward_codes_status_transition`
BEFORE UPDATE OF `status` ON `activity_reward_codes`
WHEN NOT (
	OLD.`status` = NEW.`status`
	OR (OLD.`status` = 'active' AND NEW.`status` IN ('redeemed', 'superseded', 'expired', 'revoked'))
)
BEGIN
	SELECT RAISE(ABORT, 'activity_reward_codes status may only leave active once');
END;--> statement-breakpoint
CREATE TRIGGER `activity_reward_codes_redemption_write_once`
BEFORE UPDATE OF `redeemed_at`, `redeemed_by_staff_id` ON `activity_reward_codes`
WHEN NOT (
	OLD.`redeemed_at` IS NULL
	AND OLD.`redeemed_by_staff_id` IS NULL
	AND OLD.`status` = 'active'
	AND NEW.`status` = 'redeemed'
	AND NEW.`redeemed_at` IS NOT NULL
	AND NEW.`redeemed_by_staff_id` IS NOT NULL
)
BEGIN
	SELECT RAISE(ABORT, 'activity_reward_codes redemption is exactly-once');
END;--> statement-breakpoint
CREATE TRIGGER `activity_reward_codes_supersede_write_once`
BEFORE UPDATE OF `superseded_at` ON `activity_reward_codes`
WHEN NOT (
	OLD.`superseded_at` IS NULL
	AND OLD.`status` = 'active'
	AND NEW.`status` = 'superseded'
	AND NEW.`superseded_at` IS NOT NULL
)
BEGIN
	SELECT RAISE(ABORT, 'activity_reward_codes supersede is write-once');
END;--> statement-breakpoint
CREATE TRIGGER `activity_reward_codes_revocation_write_once`
BEFORE UPDATE OF `revoked_at` ON `activity_reward_codes`
WHEN NOT (
	OLD.`revoked_at` IS NULL
	AND OLD.`status` = 'active'
	AND NEW.`status` = 'revoked'
	AND NEW.`revoked_at` IS NOT NULL
)
BEGIN
	SELECT RAISE(ABORT, 'activity_reward_codes revocation is write-once');
END;--> statement-breakpoint
CREATE TRIGGER `activity_reward_codes_grant_scope`
BEFORE INSERT ON `activity_reward_codes`
BEGIN
	SELECT RAISE(ABORT, 'credential must belong to its grant, activity and team')
	WHERE NOT EXISTS (
		SELECT 1 FROM `activity_reward_grants` g
		WHERE g.`id` = NEW.`grant_id`
			AND g.`activity_id` = NEW.`activity_id`
			AND g.`team_id` = NEW.`team_id`
			AND g.`prize_name` = NEW.`prize_name`
	);
END;--> statement-breakpoint

-- Stock/budget ledger: frozen prices, monotonic redeemed counters, and a
-- committed budget that can never exceed the cap copied from the snapshot.
CREATE TRIGGER `activity_prize_stocks_no_delete`
BEFORE DELETE ON `activity_prize_stocks`
BEGIN
	SELECT RAISE(ABORT, 'activity_prize_stocks rows are the ledger and are never deleted');
END;--> statement-breakpoint
CREATE TRIGGER `activity_prize_stocks_identity_immutable`
BEFORE UPDATE OF `activity_id`, `rule_version_id`, `prize_name`, `unit_cost_cents`, `total_quantity`, `budget_cap_cents`, `created_at` ON `activity_prize_stocks`
BEGIN
	SELECT RAISE(ABORT, 'activity_prize_stocks prices and caps are frozen from the rule version');
END;--> statement-breakpoint
-- Redeemed counters only ever grow: a reversed redemption is expressed by the
-- append-only dispute/event rows, never by "un-redeeming" the ledger.
CREATE TRIGGER `activity_prize_stocks_redeemed_monotonic`
BEFORE UPDATE OF `redeemed_quantity`, `redeemed_budget_cents` ON `activity_prize_stocks`
WHEN NEW.`redeemed_quantity` < OLD.`redeemed_quantity` OR NEW.`redeemed_budget_cents` < OLD.`redeemed_budget_cents`
BEGIN
	SELECT RAISE(ABORT, 'redeemed stock never decreases; a reversal is an appended dispute event');
END;--> statement-breakpoint
CREATE TRIGGER `activity_prize_stocks_frozen_plan_guard`
BEFORE INSERT ON `activity_prize_stocks`
BEGIN
	SELECT RAISE(ABORT, 'stock row must copy the frozen reward plan of its activity')
	WHERE NOT EXISTS (
		SELECT 1 FROM `activity_rule_versions` v
		WHERE v.`id` = NEW.`rule_version_id`
			AND v.`activity_id` = NEW.`activity_id`
			AND json_extract(v.`snapshot_json`, '$.rewardPlan') IS NOT NULL
			AND NEW.`prize_name` = json_extract(v.`snapshot_json`, '$.rewardPlan.prizeName')
			AND NEW.`unit_cost_cents` = json_extract(v.`snapshot_json`, '$.rewardPlan.prizeUnitCostCents')
			AND NEW.`total_quantity` = json_extract(v.`snapshot_json`, '$.rewardPlan.totalPrizeQuantity')
			AND NEW.`budget_cap_cents` = json_extract(v.`snapshot_json`, '$.rewardPlan.budgetCapCents')
	);
END;--> statement-breakpoint

-- Append-only audit trail: no UPDATE, no DELETE, positive per-activity sequence.
CREATE TRIGGER `activity_reward_events_no_update`
BEFORE UPDATE ON `activity_reward_events`
BEGIN
	SELECT RAISE(ABORT, 'activity_reward_events rows are append-only');
END;--> statement-breakpoint
CREATE TRIGGER `activity_reward_events_no_delete`
BEFORE DELETE ON `activity_reward_events`
BEGIN
	SELECT RAISE(ABORT, 'activity_reward_events rows are append-only');
END;--> statement-breakpoint
CREATE TRIGGER `activity_reward_events_sequence_guard`
BEFORE INSERT ON `activity_reward_events`
WHEN NEW.`sequence` IS NULL OR NEW.`sequence` < 1
BEGIN
	SELECT RAISE(ABORT, 'activity_reward_events.sequence must be a positive integer');
END;--> statement-breakpoint
CREATE TRIGGER `activity_reward_events_activity_scope`
BEFORE INSERT ON `activity_reward_events`
WHEN NEW.`grant_id` IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'reward event grant must belong to the same activity')
	WHERE NOT EXISTS (
		SELECT 1 FROM `activity_reward_grants` g
		WHERE g.`id` = NEW.`grant_id` AND g.`activity_id` = NEW.`activity_id`
	);
END;--> statement-breakpoint

-- Disputes: append-only thread, "opened" first, at most one terminal decision.
CREATE TRIGGER `activity_reward_disputes_no_update`
BEFORE UPDATE ON `activity_reward_disputes`
BEGIN
	SELECT RAISE(ABORT, 'activity_reward_disputes rows are append-only');
END;--> statement-breakpoint
CREATE TRIGGER `activity_reward_disputes_no_delete`
BEFORE DELETE ON `activity_reward_disputes`
BEGIN
	SELECT RAISE(ABORT, 'activity_reward_disputes rows are append-only');
END;--> statement-breakpoint
CREATE TRIGGER `activity_reward_disputes_open_first`
BEFORE INSERT ON `activity_reward_disputes`
BEGIN
	SELECT RAISE(ABORT, 'a dispute thread must start with "opened" and only once')
	WHERE (
		NEW.`decision` = 'opened'
		AND EXISTS (SELECT 1 FROM `activity_reward_disputes` d WHERE d.`grant_id` = NEW.`grant_id`)
	) OR (
		NEW.`decision` <> 'opened'
		AND NOT EXISTS (
			SELECT 1 FROM `activity_reward_disputes` d
			WHERE d.`grant_id` = NEW.`grant_id`
				AND d.`decision` = 'opened'
				AND d.`id` = (
					SELECT d2.`id` FROM `activity_reward_disputes` d2
					WHERE d2.`grant_id` = NEW.`grant_id`
					ORDER BY d2.`created_at` DESC, d2.`rowid` DESC
					LIMIT 1
				)
		)
	);
END;--> statement-breakpoint
CREATE TRIGGER `activity_reward_disputes_grant_scope`
BEFORE INSERT ON `activity_reward_disputes`
BEGIN
	SELECT RAISE(ABORT, 'dispute must belong to a grant of the same activity')
	WHERE NOT EXISTS (
		SELECT 1 FROM `activity_reward_grants` g
		WHERE g.`id` = NEW.`grant_id` AND g.`activity_id` = NEW.`activity_id`
	);
END;
