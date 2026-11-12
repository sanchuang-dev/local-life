CREATE TABLE `crmeb_click_attributions` (
	`id` text PRIMARY KEY NOT NULL,
	`click_id` text NOT NULL,
	`user_id` text NOT NULL,
	`activity_id` text,
	`crmeb_product_id` integer NOT NULL,
	`claimed_staff_id` text,
	`claim_state` text NOT NULL,
	`referral_code_hash` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`claimed_staff_id`) REFERENCES `staff_accounts`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "crmeb_click_attributions_staff_claim_check" CHECK("crmeb_click_attributions"."claimed_staff_id" IS NULL OR "crmeb_click_attributions"."claim_state" = 'claimed')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `crmeb_click_attributions_click_uq` ON `crmeb_click_attributions` (`click_id`);--> statement-breakpoint
CREATE INDEX `crmeb_click_attributions_user_idx` ON `crmeb_click_attributions` (`user_id`);--> statement-breakpoint
CREATE INDEX `crmeb_click_attributions_activity_idx` ON `crmeb_click_attributions` (`activity_id`);--> statement-breakpoint
CREATE INDEX `crmeb_click_attributions_staff_idx` ON `crmeb_click_attributions` (`claimed_staff_id`);--> statement-breakpoint
CREATE TABLE `crmeb_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`platform_user_id` text NOT NULL,
	`crmeb_uid` integer NOT NULL,
	`status` text NOT NULL,
	`verification_method` text NOT NULL,
	`verification_note` text,
	`created_by_user_id` text NOT NULL,
	`verified_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`platform_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `crmeb_identities_platform_user_uq` ON `crmeb_identities` (`platform_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `crmeb_identities_crmeb_uid_uq` ON `crmeb_identities` (`crmeb_uid`);--> statement-breakpoint
CREATE INDEX `crmeb_identities_created_by_idx` ON `crmeb_identities` (`created_by_user_id`);--> statement-breakpoint
CREATE TABLE `crmeb_order_events` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`event_key` text NOT NULL,
	`payload_hash` text NOT NULL,
	`payload_json` text,
	`occurred_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `crmeb_orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `crmeb_order_events_order_event_uq` ON `crmeb_order_events` (`order_id`,`event_key`);--> statement-breakpoint
CREATE INDEX `crmeb_order_events_order_idx` ON `crmeb_order_events` (`order_id`);--> statement-breakpoint
CREATE INDEX `crmeb_order_events_occurred_idx` ON `crmeb_order_events` (`occurred_at`);--> statement-breakpoint
CREATE TABLE `crmeb_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`external_order_id` integer NOT NULL,
	`external_order_no` text NOT NULL,
	`crmeb_uid` integer,
	`platform_user_id` text,
	`pay_type` text,
	`pay_amount_cents` integer NOT NULL,
	`paid` integer NOT NULL,
	`status` text NOT NULL,
	`raw_status` integer NOT NULL,
	`refund_status` integer,
	`valid_transaction` integer NOT NULL,
	`raw_hash` text NOT NULL,
	`items_json` text,
	`ordered_at` integer,
	`paid_at` integer,
	`synced_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`platform_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `crmeb_orders_channel_order_no_idx` ON `crmeb_orders` (`channel`,`external_order_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `crmeb_orders_channel_order_id_uq` ON `crmeb_orders` (`channel`,`external_order_id`);--> statement-breakpoint
CREATE INDEX `crmeb_orders_crmeb_uid_idx` ON `crmeb_orders` (`crmeb_uid`);--> statement-breakpoint
CREATE INDEX `crmeb_orders_platform_user_idx` ON `crmeb_orders` (`platform_user_id`);--> statement-breakpoint
CREATE INDEX `crmeb_orders_valid_transaction_idx` ON `crmeb_orders` (`valid_transaction`);--> statement-breakpoint
CREATE TABLE `crmeb_refunds` (
	`id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`external_refund_id` integer NOT NULL,
	`external_refund_no` text NOT NULL,
	`external_order_id` integer NOT NULL,
	`refund_type` integer NOT NULL,
	`refund_amount_cents` integer NOT NULL,
	`refunded_amount_cents` integer NOT NULL,
	`refunded_at` integer,
	`add_time` integer,
	`raw_hash` text NOT NULL,
	`synced_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `crmeb_refunds_channel_refund_no_uq` ON `crmeb_refunds` (`channel`,`external_refund_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `crmeb_refunds_channel_refund_id_uq` ON `crmeb_refunds` (`channel`,`external_refund_id`);--> statement-breakpoint
CREATE INDEX `crmeb_refunds_order_idx` ON `crmeb_refunds` (`external_order_id`);--> statement-breakpoint
CREATE TABLE `crmeb_sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`trigger` text NOT NULL,
	`actor_role` text NOT NULL,
	`actor_user_id` text,
	`scope_json` text NOT NULL,
	`cursor_json` text,
	`orders_scanned` integer DEFAULT 0 NOT NULL,
	`orders_created` integer DEFAULT 0 NOT NULL,
	`orders_updated` integer DEFAULT 0 NOT NULL,
	`orders_unchanged` integer DEFAULT 0 NOT NULL,
	`orders_failed` integer DEFAULT 0 NOT NULL,
	`refunds_scanned` integer DEFAULT 0 NOT NULL,
	`refunds_created` integer DEFAULT 0 NOT NULL,
	`refunds_updated` integer DEFAULT 0 NOT NULL,
	`refunds_unchanged` integer DEFAULT 0 NOT NULL,
	`refunds_unmatched` integer DEFAULT 0 NOT NULL,
	`valid_transactions` integer DEFAULT 0 NOT NULL,
	`events_appended` integer DEFAULT 0 NOT NULL,
	`errors_json` text,
	`error_message` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `crmeb_sync_runs_started_idx` ON `crmeb_sync_runs` (`started_at`);--> statement-breakpoint
CREATE INDEX `crmeb_sync_runs_status_idx` ON `crmeb_sync_runs` (`status`);
--> statement-breakpoint
CREATE TRIGGER `crmeb_order_events_no_update`
BEFORE UPDATE ON `crmeb_order_events`
BEGIN
	SELECT RAISE(ABORT, 'crmeb_order_events rows are append-only');
END;--> statement-breakpoint
CREATE TRIGGER `crmeb_order_events_no_delete`
BEFORE DELETE ON `crmeb_order_events`
BEGIN
	SELECT RAISE(ABORT, 'crmeb_order_events rows are append-only');
END;
