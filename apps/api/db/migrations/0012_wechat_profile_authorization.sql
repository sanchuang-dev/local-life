-- 0012 — resident-consented WeChat profile authorization (LL-MVP-011 / #121)
--
-- Extend the existing identity mapping and OAuth state table. Existing state
-- rows keep NULL purpose and are interpreted as ordinary login attempts.
-- No OAuth credentials, access tokens, or new identity table are introduced.

ALTER TABLE `wechat_identities` ADD `nickname` text;--> statement-breakpoint
ALTER TABLE `wechat_identities` ADD `avatar_url` text;--> statement-breakpoint
ALTER TABLE `wechat_identities` ADD `profile_authorized_at` integer;--> statement-breakpoint
ALTER TABLE `oauth_states` ADD `purpose` text CHECK(`purpose` IS NULL OR `purpose` IN ('login', 'profile'));--> statement-breakpoint
ALTER TABLE `oauth_states` ADD `user_id` text REFERENCES `users`(`id`) ON DELETE set null;--> statement-breakpoint
CREATE INDEX `oauth_state_user_purpose_idx` ON `oauth_states` (`user_id`,`purpose`);
