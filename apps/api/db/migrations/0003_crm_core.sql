CREATE TABLE `crm_leads` (
	`id` text PRIMARY KEY NOT NULL,
	`community_id` text NOT NULL,
	`owner_staff_id` text NOT NULL,
	`resident_user_id` text,
	`contact_name` text NOT NULL,
	`contact_phone` text NOT NULL,
	`source_type` text NOT NULL,
	`source_activity_id` text,
	`promotion_staff_id` text,
	`created_by_staff_id` text NOT NULL,
	`status` text NOT NULL,
	`next_contact_at` integer,
	`last_contacted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`owner_staff_id`) REFERENCES `staff_accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`resident_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`promotion_staff_id`) REFERENCES `staff_accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_staff_id`) REFERENCES `staff_accounts`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `crm_leads_community_owner_status_idx` ON `crm_leads` (`community_id`,`owner_staff_id`,`status`);--> statement-breakpoint
CREATE INDEX `crm_leads_next_contact_idx` ON `crm_leads` (`next_contact_at`);--> statement-breakpoint
CREATE INDEX `crm_leads_source_activity_idx` ON `crm_leads` (`source_activity_id`);--> statement-breakpoint
CREATE INDEX `crm_leads_promotion_staff_idx` ON `crm_leads` (`promotion_staff_id`);--> statement-breakpoint
CREATE TABLE `crm_lead_events` (
	`id` text PRIMARY KEY NOT NULL,
	`lead_id` text NOT NULL,
	`actor_user_id` text,
	`event` text NOT NULL,
	`from_status` text,
	`to_status` text,
	`from_owner_staff_id` text,
	`to_owner_staff_id` text,
	`note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `crm_leads`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`from_owner_staff_id`) REFERENCES `staff_accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`to_owner_staff_id`) REFERENCES `staff_accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `crm_lead_events_lead_created_idx` ON `crm_lead_events` (`lead_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `crm_follow_ups` (
	`id` text PRIMARY KEY NOT NULL,
	`lead_id` text NOT NULL,
	`staff_id` text NOT NULL,
	`content` text NOT NULL,
	`next_contact_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `crm_leads`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`staff_id`) REFERENCES `staff_accounts`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `crm_follow_ups_lead_created_idx` ON `crm_follow_ups` (`lead_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `crm_follow_ups_staff_created_idx` ON `crm_follow_ups` (`staff_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `crm_service_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`community_id` text NOT NULL,
	`lead_id` text NOT NULL,
	`order_no` text NOT NULL,
	`business_type` text NOT NULL,
	`status` text NOT NULL,
	`customer_name` text NOT NULL,
	`contact_phone` text NOT NULL,
	`evidence_ref` text,
	`notes` text,
	`created_by_staff_id` text NOT NULL,
	`attributed_staff_id` text NOT NULL,
	`source_activity_id` text,
	`promotion_staff_id` text,
	`confirmed_by_user_id` text,
	`confirmed_at` integer,
	`confirmation_note` text,
	`failure_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`lead_id`) REFERENCES `crm_leads`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_staff_id`) REFERENCES `staff_accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`attributed_staff_id`) REFERENCES `staff_accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`source_activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`promotion_staff_id`) REFERENCES `staff_accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`confirmed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `crm_service_orders_community_order_no_uq` ON `crm_service_orders` (`community_id`,`order_no`);--> statement-breakpoint
CREATE INDEX `crm_service_orders_community_status_idx` ON `crm_service_orders` (`community_id`,`status`);--> statement-breakpoint
CREATE INDEX `crm_service_orders_lead_idx` ON `crm_service_orders` (`lead_id`);--> statement-breakpoint
CREATE INDEX `crm_service_orders_attributed_staff_idx` ON `crm_service_orders` (`attributed_staff_id`);--> statement-breakpoint
CREATE INDEX `crm_service_orders_business_type_idx` ON `crm_service_orders` (`business_type`);--> statement-breakpoint
CREATE TABLE `crm_order_events` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`actor_user_id` text,
	`event` text NOT NULL,
	`from_status` text,
	`to_status` text,
	`note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `crm_service_orders`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `crm_order_events_order_created_idx` ON `crm_order_events` (`order_id`,`created_at`);--> statement-breakpoint
CREATE TRIGGER `crm_lead_events_no_update`
BEFORE UPDATE ON `crm_lead_events`
BEGIN
	SELECT RAISE(ABORT, 'crm_lead_events rows are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `crm_lead_events_no_delete`
BEFORE DELETE ON `crm_lead_events`
BEGIN
	SELECT RAISE(ABORT, 'crm_lead_events rows are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `crm_follow_ups_no_update`
BEFORE UPDATE ON `crm_follow_ups`
BEGIN
	SELECT RAISE(ABORT, 'crm_follow_ups rows are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `crm_follow_ups_no_delete`
BEFORE DELETE ON `crm_follow_ups`
BEGIN
	SELECT RAISE(ABORT, 'crm_follow_ups rows are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `crm_order_events_no_update`
BEFORE UPDATE ON `crm_order_events`
BEGIN
	SELECT RAISE(ABORT, 'crm_order_events rows are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `crm_order_events_no_delete`
BEFORE DELETE ON `crm_order_events`
BEGIN
	SELECT RAISE(ABORT, 'crm_order_events rows are immutable');
END;
