CREATE TABLE `external_offers` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`platform` text NOT NULL,
	`category` text NOT NULL,
	`description` text,
	`url` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by_user_id` text,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "external_offers_enabled_check" CHECK(enabled IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `external_offers_enabled_expiry_sort_idx` ON `external_offers` (`enabled`,`expires_at`,`sort_order`);