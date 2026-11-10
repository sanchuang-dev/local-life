ALTER TABLE `communities` ADD `address` text;--> statement-breakpoint
ALTER TABLE `communities` ADD `latitude_gcj02` real;--> statement-breakpoint
ALTER TABLE `communities` ADD `longitude_gcj02` real;--> statement-breakpoint
CREATE TABLE `tencent_map_configs` (
  `id` text PRIMARY KEY NOT NULL,
  `api_key` text NOT NULL,
  `enabled` integer NOT NULL,
  `updated_at` integer NOT NULL
);
