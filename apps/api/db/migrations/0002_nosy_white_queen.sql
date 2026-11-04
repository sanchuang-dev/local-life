CREATE TABLE `activity_invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`activity_id` text NOT NULL,
	`team_id` text NOT NULL,
	`inviter_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`team_id`) REFERENCES `activity_teams`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`inviter_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "activity_invitations_code_check" CHECK(length("activity_invitations"."code") = 32 AND "activity_invitations"."code" NOT GLOB '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activity_invitations_code_uq` ON `activity_invitations` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `activity_invitations_team_uq` ON `activity_invitations` (`team_id`);--> statement-breakpoint
CREATE INDEX `activity_invitations_activity_idx` ON `activity_invitations` (`activity_id`);--> statement-breakpoint
CREATE TABLE `activity_participations` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`seat_no` integer NOT NULL,
	`role` text NOT NULL,
	`invite_source` text NOT NULL,
	`invitation_id` text,
	`joined_at` integer NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`team_id`) REFERENCES `activity_teams`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`invitation_id`) REFERENCES `activity_invitations`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "activity_participations_seat_no_check" CHECK("activity_participations"."seat_no" BETWEEN 1 AND 3),
	CONSTRAINT "activity_participations_role_source_check" CHECK(("activity_participations"."role" = 'leader' AND "activity_participations"."seat_no" = 1 AND "activity_participations"."invite_source" = 'self' AND "activity_participations"."invitation_id" IS NULL)
        OR ("activity_participations"."role" = 'member' AND "activity_participations"."seat_no" BETWEEN 2 AND 3 AND "activity_participations"."invite_source" = 'invite' AND "activity_participations"."invitation_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activity_participations_activity_user_uq` ON `activity_participations` (`activity_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `activity_participations_team_seat_uq` ON `activity_participations` (`team_id`,`seat_no`);--> statement-breakpoint
CREATE INDEX `activity_participations_user_idx` ON `activity_participations` (`user_id`);--> statement-breakpoint
CREATE TABLE `activity_teams` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`leader_user_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`locked_at` integer,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`leader_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "activity_teams_status_check" CHECK("activity_teams"."status" IN ('open', 'locked')),
	CONSTRAINT "activity_teams_locked_at_check" CHECK(("activity_teams"."status" = 'locked' AND "activity_teams"."locked_at" IS NOT NULL)
        OR ("activity_teams"."status" = 'open' AND "activity_teams"."locked_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activity_teams_activity_leader_uq` ON `activity_teams` (`activity_id`,`leader_user_id`);--> statement-breakpoint
CREATE INDEX `activity_teams_activity_idx` ON `activity_teams` (`activity_id`);--> statement-breakpoint
CREATE INDEX `activity_teams_leader_idx` ON `activity_teams` (`leader_user_id`);--> statement-breakpoint
CREATE TRIGGER `activity_participations_no_update`
BEFORE UPDATE ON `activity_participations`
BEGIN
	SELECT RAISE(ABORT, 'activity_participations rows are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `activity_participations_no_delete`
BEFORE DELETE ON `activity_participations`
BEGIN
	SELECT RAISE(ABORT, 'activity_participations rows are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `activity_participations_team_consistency`
BEFORE INSERT ON `activity_participations`
WHEN NOT EXISTS (
	SELECT 1 FROM `activity_teams` t
	WHERE t.id = NEW.team_id
		AND t.activity_id = NEW.activity_id
		AND (
			(NEW.role = 'leader' AND t.leader_user_id = NEW.user_id)
			OR (NEW.role = 'member' AND t.leader_user_id <> NEW.user_id)
		)
)
BEGIN
	SELECT RAISE(ABORT, 'participation must match its team, activity and seat role');
END;--> statement-breakpoint
CREATE TRIGGER `activity_participations_invitation_scope`
BEFORE INSERT ON `activity_participations`
WHEN NEW.invitation_id IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'invitation must belong to the same activity and team')
	WHERE NOT EXISTS (
		SELECT 1 FROM `activity_invitations` i
		WHERE i.id = NEW.invitation_id
			AND i.activity_id = NEW.activity_id
			AND i.team_id = NEW.team_id
	);
END;--> statement-breakpoint
CREATE TRIGGER `activity_teams_no_delete`
BEFORE DELETE ON `activity_teams`
BEGIN
	SELECT RAISE(ABORT, 'activity_teams rows are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `activity_teams_identity_immutable`
BEFORE UPDATE OF `activity_id`, `leader_user_id`, `created_at` ON `activity_teams`
BEGIN
	SELECT RAISE(ABORT, 'activity_teams identity columns are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `activity_teams_status_transition`
BEFORE UPDATE OF `status` ON `activity_teams`
WHEN NOT (OLD.status = 'open' AND NEW.status = 'locked')
BEGIN
	SELECT RAISE(ABORT, 'activity_teams status may only move from open to locked');
END;--> statement-breakpoint
CREATE TRIGGER `activity_teams_locked_at_write_once`
BEFORE UPDATE OF `locked_at` ON `activity_teams`
WHEN NOT (
	OLD.status = 'open'
	AND OLD.locked_at IS NULL
	AND NEW.status = 'locked'
	AND NEW.locked_at IS NOT NULL
)
BEGIN
	SELECT RAISE(ABORT, 'activity_teams locked_at is write-once and set only while locking');
END;--> statement-breakpoint
CREATE TRIGGER `activity_invitations_no_update`
BEFORE UPDATE ON `activity_invitations`
BEGIN
	SELECT RAISE(ABORT, 'activity_invitations rows are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `activity_invitations_no_delete`
BEFORE DELETE ON `activity_invitations`
BEGIN
	SELECT RAISE(ABORT, 'activity_invitations rows are immutable');
END;
