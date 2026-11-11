CREATE TABLE `activity_draw_events` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`prize_id` text,
	`kind` text NOT NULL,
	`actor_user_id` text,
	`metadata_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`prize_id`) REFERENCES `activity_draw_prizes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "activity_draw_events_kind_check" CHECK("activity_draw_events"."kind" IN (
        'draw_pool.created',
        'draw_pool.updated',
        'draw_pool.enabled',
        'draw_pool.disabled',
        'draw_prize.created',
        'draw_prize.updated',
        'draw_prize.enabled',
        'draw_prize.disabled'
      ))
);
--> statement-breakpoint
CREATE INDEX `activity_draw_events_activity_idx` ON `activity_draw_events` (`activity_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `activity_draw_pools` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`community_id` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`daily_draw_limit_per_resident` integer NOT NULL,
	`no_prize_weight` integer DEFAULT 0 NOT NULL,
	`created_by_user_id` text,
	`updated_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "activity_draw_pools_enabled_check" CHECK("activity_draw_pools"."enabled" IN (0, 1)),
	CONSTRAINT "activity_draw_pools_daily_limit_check" CHECK("activity_draw_pools"."daily_draw_limit_per_resident" >= 1 AND "activity_draw_pools"."daily_draw_limit_per_resident" <= 100),
	CONSTRAINT "activity_draw_pools_no_prize_weight_check" CHECK("activity_draw_pools"."no_prize_weight" >= 0 AND "activity_draw_pools"."no_prize_weight" <= 1000000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activity_draw_pools_activity_id_unique` ON `activity_draw_pools` (`activity_id`);--> statement-breakpoint
CREATE INDEX `activity_draw_pools_community_idx` ON `activity_draw_pools` (`community_id`);--> statement-breakpoint
CREATE TABLE `activity_draw_prizes` (
	`id` text PRIMARY KEY NOT NULL,
	`pool_id` text NOT NULL,
	`activity_id` text NOT NULL,
	`community_id` text NOT NULL,
	`product_id` text NOT NULL,
	`product_name` text NOT NULL,
	`product_image_url` text,
	`cost_cents` integer NOT NULL,
	`total_quantity` integer NOT NULL,
	`drawn_quantity` integer DEFAULT 0 NOT NULL,
	`remaining_quantity` integer NOT NULL,
	`weight` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`created_by_user_id` text,
	`updated_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`pool_id`) REFERENCES `activity_draw_pools`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`product_id`) REFERENCES `local_products`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "activity_draw_prizes_quantity_check" CHECK("activity_draw_prizes"."total_quantity" > 0
        AND "activity_draw_prizes"."total_quantity" <= 100000
        AND "activity_draw_prizes"."drawn_quantity" >= 0
        AND "activity_draw_prizes"."remaining_quantity" >= 0
        AND "activity_draw_prizes"."drawn_quantity" + "activity_draw_prizes"."remaining_quantity" = "activity_draw_prizes"."total_quantity"),
	CONSTRAINT "activity_draw_prizes_weight_check" CHECK("activity_draw_prizes"."weight" >= 0 AND "activity_draw_prizes"."weight" <= 1000000),
	CONSTRAINT "activity_draw_prizes_enabled_check" CHECK("activity_draw_prizes"."enabled" IN (0, 1)),
	CONSTRAINT "activity_draw_prizes_cost_check" CHECK("activity_draw_prizes"."cost_cents" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activity_draw_prizes_activity_product_uq` ON `activity_draw_prizes` (`activity_id`,`product_id`);--> statement-breakpoint
CREATE INDEX `activity_draw_prizes_pool_idx` ON `activity_draw_prizes` (`pool_id`);--> statement-breakpoint
CREATE INDEX `activity_draw_prizes_activity_idx` ON `activity_draw_prizes` (`activity_id`);
--> statement-breakpoint
/* ------------------------------------------------------------------------- */
/* Draw-pool invariants (hand-written on top of the generated DDL)           */
/* ------------------------------------------------------------------------- */

CREATE TRIGGER `activity_draw_pools_community_guard_insert`
BEFORE INSERT ON `activity_draw_pools`
BEGIN
  SELECT RAISE(ABORT, 'activity_draw_pool_scope_mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM `activities` a
    WHERE a.`id` = NEW.`activity_id` AND a.`community_id` = NEW.`community_id`
  );
END;
--> statement-breakpoint

CREATE TRIGGER `activity_draw_pools_community_guard_update`
BEFORE UPDATE ON `activity_draw_pools`
BEGIN
  SELECT RAISE(ABORT, 'activity_draw_pool_scope_mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM `activities` a
    WHERE a.`id` = NEW.`activity_id` AND a.`community_id` = NEW.`community_id`
  );
  SELECT RAISE(ABORT, 'activity_draw_pool_identity_locked')
  WHERE NEW.`activity_id` <> OLD.`activity_id`
     OR NEW.`community_id` <> OLD.`community_id`;
END;
--> statement-breakpoint

CREATE TRIGGER `activity_draw_pools_no_delete`
BEFORE DELETE ON `activity_draw_pools`
BEGIN
  SELECT RAISE(ABORT, 'activity_draw_pool_delete_forbidden');
END;
--> statement-breakpoint

CREATE TRIGGER `activity_draw_prizes_scope_guard_insert`
BEFORE INSERT ON `activity_draw_prizes`
BEGIN
  SELECT RAISE(ABORT, 'activity_draw_prize_scope_mismatch')
  WHERE NOT EXISTS (
    SELECT 1
    FROM `activity_draw_pools` p
    JOIN `activities` a ON a.`id` = p.`activity_id`
    JOIN `local_products` lp ON lp.`id` = NEW.`product_id`
    WHERE p.`id` = NEW.`pool_id`
      AND p.`activity_id` = NEW.`activity_id`
      AND p.`community_id` = NEW.`community_id`
      AND a.`community_id` = NEW.`community_id`
      AND lp.`community_id` = NEW.`community_id`
  );
END;
--> statement-breakpoint

CREATE TRIGGER `activity_draw_prizes_scope_guard_update`
BEFORE UPDATE ON `activity_draw_prizes`
BEGIN
  SELECT RAISE(ABORT, 'activity_draw_prize_scope_mismatch')
  WHERE NOT EXISTS (
    SELECT 1
    FROM `activity_draw_pools` p
    JOIN `activities` a ON a.`id` = p.`activity_id`
    JOIN `local_products` lp ON lp.`id` = NEW.`product_id`
    WHERE p.`id` = NEW.`pool_id`
      AND p.`activity_id` = NEW.`activity_id`
      AND p.`community_id` = NEW.`community_id`
      AND a.`community_id` = NEW.`community_id`
      AND lp.`community_id` = NEW.`community_id`
  );
  SELECT RAISE(ABORT, 'activity_draw_prize_identity_locked')
  WHERE NEW.`pool_id` <> OLD.`pool_id`
     OR NEW.`activity_id` <> OLD.`activity_id`
     OR NEW.`community_id` <> OLD.`community_id`
     OR NEW.`product_id` <> OLD.`product_id`;
END;
--> statement-breakpoint

/* An awarded prize is a promise: its snapshot can never be rewritten. */
CREATE TRIGGER `activity_draw_prizes_snapshot_guard`
BEFORE UPDATE ON `activity_draw_prizes`
WHEN OLD.`drawn_quantity` > 0
BEGIN
  SELECT RAISE(ABORT, 'activity_draw_prize_snapshot_locked')
  WHERE NEW.`product_name` <> OLD.`product_name`
     OR COALESCE(NEW.`product_image_url`, '') <> COALESCE(OLD.`product_image_url`, '')
     OR NEW.`cost_cents` <> OLD.`cost_cents`;
END;
--> statement-breakpoint

/* Drawing may only consume stock; nothing can add drawn stock back. */
CREATE TRIGGER `activity_draw_prizes_drawn_monotonic`
BEFORE UPDATE ON `activity_draw_prizes`
WHEN NEW.`drawn_quantity` < OLD.`drawn_quantity`
BEGIN
  SELECT RAISE(ABORT, 'activity_draw_prize_drawn_decreased');
END;
--> statement-breakpoint

CREATE TRIGGER `activity_draw_prizes_no_delete`
BEFORE DELETE ON `activity_draw_prizes`
BEGIN
  SELECT RAISE(ABORT, 'activity_draw_prize_delete_forbidden');
END;
--> statement-breakpoint

CREATE TRIGGER `activity_draw_events_scope_guard`
BEFORE INSERT ON `activity_draw_events`
WHEN NEW.`prize_id` IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'activity_draw_event_scope_mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM `activity_draw_prizes` p
    WHERE p.`id` = NEW.`prize_id` AND p.`activity_id` = NEW.`activity_id`
  );
END;
--> statement-breakpoint

CREATE TRIGGER `activity_draw_events_no_update`
BEFORE UPDATE ON `activity_draw_events`
BEGIN
  SELECT RAISE(ABORT, 'activity_draw_events_append_only');
END;
--> statement-breakpoint

CREATE TRIGGER `activity_draw_events_no_delete`
BEFORE DELETE ON `activity_draw_events`
BEGIN
  SELECT RAISE(ABORT, 'activity_draw_events_append_only');
END;
