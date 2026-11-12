-- 0024 — Local good orders bind one consumption team, permanently (#207 LL-PUR-003)
--
-- `source_activity_id` existed but nothing tied an order to a resident's actual
-- team, so a bare activity could be read as "counts for a team". This migration
-- adds the missing anchor and makes the relationship enforced by the database,
-- not only by the service:
--
--   * one nullable `source_team_id` -> at most one team per order, structurally;
--   * a team is accepted only when the resident really joined that team of the
--     *same* activity no later than the order's `created_at`;
--   * `source_activity_id`, when present, must belong to the order's community;
--   * both attribution columns become immutable after insert.
--
-- Existing orders stay NULL. #207 never guesses a team from a bare
-- `source_activity_id`; backfilling is explicitly out of scope.
--
-- No rollback statement: drizzle-orm's better-sqlite3 migrator applies each file
-- inside a transaction, so a failure leaves the database at 0023 intact.

ALTER TABLE `local_orders` ADD `source_team_id` text REFERENCES activity_teams(id);--> statement-breakpoint
CREATE INDEX `local_orders_source_team_idx` ON `local_orders` (`source_team_id`);--> statement-breakpoint
CREATE TRIGGER `local_orders_source_activity_community_check`
BEFORE INSERT ON `local_orders`
WHEN NEW.`source_activity_id` IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'local_orders source_activity_id must belong to the order community')
	WHERE NOT EXISTS (
		SELECT 1
		FROM `activities`
		WHERE `activities`.`id` = NEW.`source_activity_id`
			AND `activities`.`community_id` = NEW.`community_id`
	);
END;--> statement-breakpoint
CREATE TRIGGER `local_orders_source_team_check`
BEFORE INSERT ON `local_orders`
WHEN NEW.`source_team_id` IS NOT NULL
BEGIN
	-- A team without its activity would make "which activity was this order
	-- attributed to?" ambiguous, so reject the half-filled pair outright.
	SELECT RAISE(ABORT, 'local_orders source_team_id requires source_activity_id')
	WHERE NEW.`source_activity_id` IS NULL;
	-- The attribution must be a relation the resident already has, in the same
	-- activity, joined no later than this order was created. Another resident's
	-- team and another activity's team both fail here.
	SELECT RAISE(ABORT, 'local_orders source_team_id must be a team the resident joined in that activity')
	WHERE NOT EXISTS (
		SELECT 1
		FROM `activity_teams` AS team
		INNER JOIN `activity_participations` AS participation
			ON `participation`.`team_id` = `team`.`id`
			AND `participation`.`user_id` = NEW.`resident_user_id`
		WHERE `team`.`id` = NEW.`source_team_id`
			AND `team`.`activity_id` = NEW.`source_activity_id`
			AND `participation`.`joined_at` <= NEW.`created_at`
	);
END;--> statement-breakpoint
-- Permanent attribution: no status transition, retry or staff action may move an
-- already-registered order to another team (or retro-fill one).
CREATE TRIGGER `local_orders_attribution_immutable`
BEFORE UPDATE ON `local_orders`
WHEN OLD.`source_activity_id` IS NOT NEW.`source_activity_id`
	OR OLD.`source_team_id` IS NOT NEW.`source_team_id`
BEGIN
	SELECT RAISE(ABORT, 'local_orders attribution is immutable');
END;
