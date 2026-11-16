-- LL-PROFILE-001 (#257): resident-owned editable contact profile.
-- Phone remains exclusively in resident_phone_identities; this table stores no
-- unverified phone copy and no WeChat identity fields.
CREATE TABLE `resident_profiles` (
  `user_id` text PRIMARY KEY NOT NULL,
  `contact_address` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
  CONSTRAINT `resident_profiles_contact_address_check`
    CHECK(`contact_address` IS NULL OR (length(trim(`contact_address`)) BETWEEN 1 AND 200))
);
