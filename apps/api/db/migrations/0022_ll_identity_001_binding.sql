CREATE TABLE `resident_community_binding_candidates` (
	`user_id` text PRIMARY KEY NOT NULL,
	`community_id` text NOT NULL,
	`source` text NOT NULL,
	`suggested_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "resident_community_candidates_source_check" CHECK("resident_community_binding_candidates"."source" IN ('activity_oauth_candidate')),
	CONSTRAINT "resident_community_candidates_expiry_check" CHECK("resident_community_binding_candidates"."expires_at" > "resident_community_binding_candidates"."suggested_at")
);
--> statement-breakpoint
CREATE INDEX `resident_community_candidates_community_idx` ON `resident_community_binding_candidates` (`community_id`);--> statement-breakpoint
CREATE TABLE `resident_community_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`community_id` text NOT NULL,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`confirmed_at` integer NOT NULL,
	`source` text NOT NULL,
	`confirmed_by_user_id` text,
	`evidence_ref` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`confirmed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "resident_community_bindings_status_check" CHECK("resident_community_bindings"."status" = 'confirmed'),
	CONSTRAINT "resident_community_bindings_source_check" CHECK("resident_community_bindings"."source" IN ('resident_h5_confirmed', 'admin_compliance_correction')),
	CONSTRAINT "resident_community_bindings_evidence_check" CHECK(length("resident_community_bindings"."evidence_ref") > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `resident_community_bindings_user_confirmed_uq` ON `resident_community_bindings` (`user_id`) WHERE "resident_community_bindings"."status" = 'confirmed';--> statement-breakpoint
CREATE INDEX `resident_community_bindings_community_idx` ON `resident_community_bindings` (`community_id`);
