CREATE TABLE `phone_otp_request_counters` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`window_started_at` integer NOT NULL,
	CONSTRAINT "phone_otp_request_counters_count_check" CHECK("phone_otp_request_counters"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE `phone_verification_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`phone` text NOT NULL,
	`purpose` text NOT NULL,
	`code_hash` text NOT NULL,
	`attempts` integer NOT NULL,
	`max_attempts` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`invalidated_at` integer,
	`request_ip_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "phone_verification_codes_purpose_check" CHECK("phone_verification_codes"."purpose" IN ('login', 'bind')),
	CONSTRAINT "phone_verification_codes_hash_check" CHECK(length("phone_verification_codes"."code_hash") = 64 AND "phone_verification_codes"."code_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "phone_verification_codes_attempts_check" CHECK("phone_verification_codes"."attempts" >= 0
        AND "phone_verification_codes"."max_attempts" > 0
        AND "phone_verification_codes"."attempts" <= "phone_verification_codes"."max_attempts"),
	CONSTRAINT "phone_verification_codes_expiry_check" CHECK("phone_verification_codes"."expires_at" > "phone_verification_codes"."created_at")
);
--> statement-breakpoint
CREATE INDEX `phone_verification_codes_phone_purpose_idx` ON `phone_verification_codes` (`phone`,`purpose`,`created_at`);--> statement-breakpoint
CREATE INDEX `phone_verification_codes_expiry_idx` ON `phone_verification_codes` (`expires_at`);--> statement-breakpoint
CREATE TABLE `resident_phone_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`phone` text NOT NULL,
	`verified_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "resident_phone_identities_phone_check" CHECK(length("resident_phone_identities"."phone") = 11
        AND "resident_phone_identities"."phone" NOT GLOB '*[^0-9]*'
        AND substr("resident_phone_identities"."phone", 1, 1) = '1'
        AND substr("resident_phone_identities"."phone", 2, 1) BETWEEN '3' AND '9')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `resident_phone_identities_phone_uq` ON `resident_phone_identities` (`phone`);--> statement-breakpoint
CREATE UNIQUE INDEX `resident_phone_identities_user_uq` ON `resident_phone_identities` (`user_id`);
-- The rewards index quoting rewrite that drizzle-kit also proposed is not part of
-- this migration: the index already exists from 0006 and this card must not touch
-- the rewards domain. The snapshot records the canonical definition.
