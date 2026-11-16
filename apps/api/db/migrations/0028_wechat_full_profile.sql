-- LL-AUTH-002 (#256): complete WeChat snsapi_userinfo profile.
-- Existing OpenID-only identities remain valid rows and are backfilled only
-- after that resident completes a real snsapi_userinfo login.
ALTER TABLE `wechat_identities` ADD `sex` integer CHECK(`sex` IS NULL OR `sex` IN (0,1,2));--> statement-breakpoint
ALTER TABLE `wechat_identities` ADD `province` text;--> statement-breakpoint
ALTER TABLE `wechat_identities` ADD `city` text;--> statement-breakpoint
ALTER TABLE `wechat_identities` ADD `country` text;--> statement-breakpoint
ALTER TABLE `wechat_identities` ADD `privilege_json` text;--> statement-breakpoint
ALTER TABLE `wechat_identities` ADD `profile_updated_at` integer;
