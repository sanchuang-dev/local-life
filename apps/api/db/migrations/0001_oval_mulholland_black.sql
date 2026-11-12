CREATE TABLE `activities` (
	`id` text PRIMARY KEY NOT NULL,
	`community_id` text NOT NULL,
	`title` text NOT NULL,
	`summary` text,
	`description` text,
	`status` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`location` text NOT NULL,
	`budget_cap_cents` integer NOT NULL,
	`prize_quantity_cap` integer NOT NULL,
	`public_rules_json` text NOT NULL,
	`current_rule_version_id` text,
	`created_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`published_at` integer,
	`paused_at` integer,
	`ended_at` integer,
	FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`current_rule_version_id`) REFERENCES `activity_rule_versions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `activities_community_idx` ON `activities` (`community_id`);--> statement-breakpoint
CREATE INDEX `activities_status_idx` ON `activities` (`status`);--> statement-breakpoint
CREATE INDEX `activities_starts_at_idx` ON `activities` (`starts_at`);--> statement-breakpoint
CREATE TABLE `activity_rule_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`version` integer NOT NULL,
	`snapshot_json` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activity_rule_versions_activity_version_uq` ON `activity_rule_versions` (`activity_id`,`version`);--> statement-breakpoint
CREATE INDEX `activity_rule_versions_activity_idx` ON `activity_rule_versions` (`activity_id`);--> statement-breakpoint
CREATE INDEX `audit_logs_target_idx` ON `audit_logs` (`target_id`);--> statement-breakpoint
CREATE TRIGGER `activity_rule_versions_no_update`
BEFORE UPDATE ON `activity_rule_versions`
BEGIN
	SELECT RAISE(ABORT, 'activity_rule_versions rows are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `activity_rule_versions_no_delete`
BEFORE DELETE ON `activity_rule_versions`
BEGIN
	SELECT RAISE(ABORT, 'activity_rule_versions rows are immutable');
END;
