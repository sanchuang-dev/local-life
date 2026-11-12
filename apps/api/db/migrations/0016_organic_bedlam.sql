CREATE TABLE `activity_draw_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`pool_id` text NOT NULL,
	`user_id` text NOT NULL,
	`day` text NOT NULL,
	`sequence` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`outcome` text NOT NULL,
	`prize_id` text,
	`prize_name` text,
	`prize_image_url` text,
	`prize_cost_cents` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`pool_id`) REFERENCES `activity_draw_pools`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`prize_id`) REFERENCES `activity_draw_prizes`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "draw_attempts_seq_check" CHECK("activity_draw_attempts"."sequence" >= 1),
	CONSTRAINT "draw_attempts_outcome_check" CHECK("activity_draw_attempts"."outcome" IN ('won','missed')),
	CONSTRAINT "draw_attempts_snapshot_check" CHECK((
    ("activity_draw_attempts"."outcome"='missed' AND "activity_draw_attempts"."prize_id" IS NULL AND "activity_draw_attempts"."prize_name" IS NULL AND "activity_draw_attempts"."prize_cost_cents" IS NULL)
    OR ("activity_draw_attempts"."outcome"='won' AND "activity_draw_attempts"."prize_id" IS NOT NULL AND "activity_draw_attempts"."prize_name" IS NOT NULL AND "activity_draw_attempts"."prize_cost_cents" >= 0)
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `draw_attempts_idempotency_uq` ON `activity_draw_attempts` (`activity_id`,`user_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `draw_attempts_daily_slot_uq` ON `activity_draw_attempts` (`activity_id`,`user_id`,`day`,`sequence`);--> statement-breakpoint
CREATE INDEX `draw_attempts_user_day_idx` ON `activity_draw_attempts` (`user_id`,`activity_id`,`day`);--> statement-breakpoint
CREATE TABLE `activity_draw_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`activity_id` text NOT NULL,
	`user_id` text NOT NULL,
	`prize_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`code_suffix` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`redeemed_at` integer,
	`redeemed_by_staff_id` text,
	`revoked_at` integer,
	`revoked_by_staff_id` text,
	`revoke_reason` text,
	FOREIGN KEY (`attempt_id`) REFERENCES `activity_draw_attempts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`prize_id`) REFERENCES `activity_draw_prizes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`redeemed_by_staff_id`) REFERENCES `staff_accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`revoked_by_staff_id`) REFERENCES `staff_accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "draw_credentials_status_check" CHECK("activity_draw_credentials"."status" IN ('active','redeemed','revoked')),
	CONSTRAINT "draw_credentials_stamps_check" CHECK((
    ("activity_draw_credentials"."status"='active' AND "activity_draw_credentials"."redeemed_at" IS NULL AND "activity_draw_credentials"."revoked_at" IS NULL)
    OR ("activity_draw_credentials"."status"='redeemed' AND "activity_draw_credentials"."redeemed_at" IS NOT NULL AND "activity_draw_credentials"."redeemed_by_staff_id" IS NOT NULL AND "activity_draw_credentials"."revoked_at" IS NULL)
    OR ("activity_draw_credentials"."status"='revoked' AND "activity_draw_credentials"."revoked_at" IS NOT NULL AND "activity_draw_credentials"."revoked_by_staff_id" IS NOT NULL AND "activity_draw_credentials"."redeemed_at" IS NULL)
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activity_draw_credentials_attempt_id_unique` ON `activity_draw_credentials` (`attempt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `activity_draw_credentials_code_hash_unique` ON `activity_draw_credentials` (`code_hash`);--> statement-breakpoint
CREATE INDEX `draw_credentials_activity_status_idx` ON `activity_draw_credentials` (`activity_id`,`status`);--> statement-breakpoint
CREATE TABLE `activity_draw_fulfilment_events` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`kind` text NOT NULL,
	`actor_user_id` text,
	`staff_id` text,
	`note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`credential_id`) REFERENCES `activity_draw_credentials`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`staff_id`) REFERENCES `staff_accounts`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "draw_fulfilment_events_kind_check" CHECK("activity_draw_fulfilment_events"."kind" IN ('issued','redeemed','revoked','disputed'))
);
--> statement-breakpoint
CREATE INDEX `draw_fulfilment_events_credential_idx` ON `activity_draw_fulfilment_events` (`credential_id`,`created_at`);--> statement-breakpoint
/* The daily result and the frozen award promise are append-only. */
CREATE TRIGGER activity_draw_attempts_no_update BEFORE UPDATE ON activity_draw_attempts
BEGIN SELECT RAISE(ABORT, 'draw_attempt_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER activity_draw_attempts_no_delete BEFORE DELETE ON activity_draw_attempts
BEGIN SELECT RAISE(ABORT, 'draw_attempt_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER activity_draw_credentials_identity_guard BEFORE UPDATE ON activity_draw_credentials
BEGIN
  SELECT RAISE(ABORT, 'draw_credential_identity_locked')
  WHERE NEW.id <> OLD.id OR NEW.attempt_id <> OLD.attempt_id OR
    NEW.activity_id <> OLD.activity_id OR NEW.user_id <> OLD.user_id OR
    NEW.prize_id <> OLD.prize_id OR NEW.code_hash <> OLD.code_hash OR NEW.code_suffix <> OLD.code_suffix OR
    NEW.created_at <> OLD.created_at;
  SELECT RAISE(ABORT, 'draw_credential_transition_invalid')
  WHERE OLD.status <> 'active' AND NEW.status <> OLD.status;
END;
--> statement-breakpoint
CREATE TRIGGER activity_draw_credentials_no_delete BEFORE DELETE ON activity_draw_credentials
BEGIN SELECT RAISE(ABORT, 'draw_credential_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER activity_draw_fulfilment_events_no_update BEFORE UPDATE ON activity_draw_fulfilment_events
BEGIN SELECT RAISE(ABORT, 'draw_fulfilment_event_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER activity_draw_fulfilment_events_no_delete BEFORE DELETE ON activity_draw_fulfilment_events
BEGIN SELECT RAISE(ABORT, 'draw_fulfilment_event_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER activity_draw_credential_scope_guard BEFORE INSERT ON activity_draw_credentials
BEGIN
  SELECT RAISE(ABORT, 'draw_credential_scope_mismatch') WHERE NOT EXISTS (
    SELECT 1 FROM activity_draw_attempts a WHERE a.id=NEW.attempt_id
      AND a.activity_id=NEW.activity_id AND a.user_id=NEW.user_id
      AND a.prize_id=NEW.prize_id AND a.outcome='won'
  );
END;
--> statement-breakpoint
CREATE TRIGGER activity_draw_fulfilment_scope_guard BEFORE INSERT ON activity_draw_fulfilment_events
BEGIN
  SELECT RAISE(ABORT, 'draw_fulfilment_scope_mismatch') WHERE NOT EXISTS (
    SELECT 1 FROM activity_draw_credentials c WHERE c.id=NEW.credential_id AND c.activity_id=NEW.activity_id
  );
END;
