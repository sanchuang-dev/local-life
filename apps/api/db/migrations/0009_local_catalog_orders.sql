-- 0009 — Local product catalogue & resident order registration (#109 LL-MVP-010)
--
-- Three new tables, deliberately separate from every existing order domain:
--   * `local_products`      real local catalogue rows owned by one community
--   * `local_orders`        a resident's registration of intent + frozen snapshot
--   * `local_order_events`  append-only timeline, `source_type`/`source_id` stable
--
-- NOT reused on purpose:
--   * `crm_service_orders` / `crm_order_events` are 广电 carrier acceptance orders
--     (`business_type = gd_mobile|gd_tv`, `confirmed` = a verified carrier deal).
--   * `crmeb_orders` / `crmeb_identities` / `crmeb_order_events` are a pull-only
--     mirror of an external shop (`external_order_id`, `raw_status`, `raw_hash`
--     are NOT NULL). Writing a local registration there would fabricate a
--     non-existent upstream order.
--
-- Intentional facts encoded on disk:
--   * `local_orders_idempotency_uq` (community_id, resident_user_id,
--     idempotency_key) is what makes a duplicate submission — even a concurrent
--     one — incapable of producing a second order.
--   * `local_orders_total_check` keeps `total_cents = unit_price_cents * quantity`
--     true even if a service bug computes it wrong.
--   * `local_orders` has no payment/activation column at all: `verified` is an
--     operations manual fact check, never "已付款" or "已开通".
--   * Triggers make `local_order_events` append-only, matching `crm_*_events`
--     and `crmeb_order_events`.
--
-- No rollback statement: drizzle-orm's better-sqlite3 migrator applies each file
-- inside a transaction, so a failure leaves the database at 0008 intact.

CREATE TABLE `local_order_events` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`actor_user_id` text,
	`actor_staff_id` text,
	`event` text NOT NULL,
	`from_status` text,
	`to_status` text,
	`note` text,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `local_orders`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`actor_staff_id`) REFERENCES `staff_accounts`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "local_order_events_source_type_check" CHECK("local_order_events"."source_type" = 'local_order'),
	CONSTRAINT "local_order_events_event_check" CHECK("local_order_events"."event" IN ('order.registered', 'order.created_on_behalf', 'order.status_changed', 'order.verified', 'order.rejected'))
);
--> statement-breakpoint
CREATE INDEX `local_order_events_order_created_idx` ON `local_order_events` (`order_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `local_order_events_source_idx` ON `local_order_events` (`source_type`,`source_id`);--> statement-breakpoint
CREATE TABLE `local_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`community_id` text NOT NULL,
	`product_id` text NOT NULL,
	`resident_user_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`status` text NOT NULL,
	`record_source` text NOT NULL,
	`product_name` text NOT NULL,
	`unit_price_cents` integer NOT NULL,
	`quantity` integer NOT NULL,
	`total_cents` integer NOT NULL,
	`note` text,
	`created_by_staff_id` text,
	`attributed_staff_id` text,
	`source_activity_id` text,
	`verified_by_user_id` text,
	`verified_at` integer,
	`verification_note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`product_id`) REFERENCES `local_products`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`resident_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_staff_id`) REFERENCES `staff_accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`attributed_staff_id`) REFERENCES `staff_accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`verified_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "local_orders_quantity_check" CHECK("local_orders"."quantity" >= 1 AND "local_orders"."quantity" <= 99),
	CONSTRAINT "local_orders_total_check" CHECK("local_orders"."total_cents" = "local_orders"."unit_price_cents" * "local_orders"."quantity"),
	CONSTRAINT "local_orders_status_check" CHECK("local_orders"."status" IN ('registered', 'processing', 'pending_review', 'verified', 'cancelled', 'rejected')),
	CONSTRAINT "local_orders_record_source_check" CHECK("local_orders"."record_source" IN ('resident', 'staff_on_behalf'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_orders_idempotency_uq` ON `local_orders` (`community_id`,`resident_user_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `local_orders_community_status_idx` ON `local_orders` (`community_id`,`status`);--> statement-breakpoint
CREATE INDEX `local_orders_resident_created_idx` ON `local_orders` (`resident_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `local_orders_product_idx` ON `local_orders` (`product_id`);--> statement-breakpoint
CREATE INDEX `local_orders_created_by_staff_idx` ON `local_orders` (`created_by_staff_id`);--> statement-breakpoint
CREATE TABLE `local_products` (
	`id` text PRIMARY KEY NOT NULL,
	`community_id` text NOT NULL,
	`name` text NOT NULL,
	`summary` text,
	`description` text,
	`category` text,
	`unit_price_cents` integer NOT NULL,
	`image_url` text,
	`status` text NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "local_products_price_check" CHECK("local_products"."unit_price_cents" >= 0),
	CONSTRAINT "local_products_status_check" CHECK("local_products"."status" IN ('on_shelf', 'off_shelf'))
);
--> statement-breakpoint
CREATE INDEX `local_products_community_status_idx` ON `local_products` (`community_id`,`status`);--> statement-breakpoint
CREATE INDEX `local_products_community_updated_idx` ON `local_products` (`community_id`,`updated_at`);--> statement-breakpoint
CREATE TRIGGER `local_order_events_no_update`
BEFORE UPDATE ON `local_order_events`
BEGIN
	SELECT RAISE(ABORT, 'local_order_events rows are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `local_order_events_no_delete`
BEFORE DELETE ON `local_order_events`
BEGIN
	SELECT RAISE(ABORT, 'local_order_events rows are immutable');
END;
