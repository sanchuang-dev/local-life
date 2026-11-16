-- One grid worker owns at most one logical territory; one territory has at most
-- one grid worker. Operators keep the existing many-to-many authorization model.
--
-- The kind is backfilled from the immutable staff role, not guessed from row
-- order. If historical rows already violate the new rule, the TEMP guard aborts
-- the migration with a readable message instead of picking a winner or deleting
-- history. Resolve conflicts with
-- `pnpm --filter @sanchuang-dev/local-life-api db:grid-territory:preflight`
-- before retrying the migration.
CREATE TEMP TABLE `_grid_territory_guard` (`ok` INTEGER);
--> statement-breakpoint
CREATE TEMP TRIGGER `_grid_territory_guard_check`
BEFORE INSERT ON `_grid_territory_guard`
WHEN EXISTS (
  SELECT 1 FROM (
    SELECT sca.staff_account_id
    FROM staff_community_assignments sca
    JOIN staff_accounts sa ON sa.id = sca.staff_account_id
    WHERE sa.role = 'grid_worker'
    GROUP BY sca.staff_account_id
    HAVING COUNT(*) > 1
  )
) OR EXISTS (
  SELECT 1 FROM (
    SELECT sca.community_id
    FROM staff_community_assignments sca
    JOIN staff_accounts sa ON sa.id = sca.staff_account_id
    WHERE sa.role = 'grid_worker'
    GROUP BY sca.community_id
    HAVING COUNT(*) > 1
  )
)
BEGIN
  SELECT RAISE(ABORT, 'grid territory conflict: resolve preflight conflicts before migrating');
END;
--> statement-breakpoint
INSERT INTO `_grid_territory_guard` (`ok`) VALUES (1);
--> statement-breakpoint
DROP TRIGGER `_grid_territory_guard_check`;
--> statement-breakpoint
DROP TABLE `_grid_territory_guard`;
--> statement-breakpoint
CREATE TABLE `staff_community_assignments_new` (
	`staff_account_id` text NOT NULL,
	`community_id` text NOT NULL,
	`assignment_kind` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`staff_account_id`, `community_id`),
	FOREIGN KEY (`staff_account_id`) REFERENCES `staff_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "staff_community_assignment_kind_check" CHECK("staff_community_assignments_new"."assignment_kind" IN ('operator_scope', 'grid_territory'))
);
--> statement-breakpoint
INSERT INTO `staff_community_assignments_new`
  (`staff_account_id`, `community_id`, `assignment_kind`, `created_at`)
SELECT
  sca.`staff_account_id`,
  sca.`community_id`,
  CASE WHEN sa.`role` = 'grid_worker' THEN 'grid_territory' ELSE 'operator_scope' END,
  sca.`created_at`
FROM `staff_community_assignments` sca
JOIN `staff_accounts` sa ON sa.`id` = sca.`staff_account_id`;
--> statement-breakpoint
DROP TABLE `staff_community_assignments`;
--> statement-breakpoint
ALTER TABLE `staff_community_assignments_new` RENAME TO `staff_community_assignments`;
--> statement-breakpoint
CREATE INDEX `staff_community_community_idx` ON `staff_community_assignments` (`community_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `staff_community_grid_staff_uq`
  ON `staff_community_assignments` (`staff_account_id`)
  WHERE `assignment_kind` = 'grid_territory';
--> statement-breakpoint
CREATE UNIQUE INDEX `staff_community_grid_territory_uq`
  ON `staff_community_assignments` (`community_id`)
  WHERE `assignment_kind` = 'grid_territory';
