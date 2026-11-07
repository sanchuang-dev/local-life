-- 0010 — WeChat public-account admin config, encrypted at rest (#113 LL-SYS-001)
--
-- New table `wechat_oauth_configs` stores VERSIONED credentials. There is no
-- plaintext secret column at all: only AES-256-GCM ciphertext/iv/tag (base64)
-- plus the `key_id` generation label. A secret therefore cannot be persisted
-- even by a buggy INSERT that forgets to encrypt.
--
-- Intentional facts encoded on disk:
--   * `wechat_oauth_configs_active_uq` is a partial UNIQUE index on `status`
--     WHERE status = 'active': at most one runtime provider can ever exist,
--     even if application code is bypassed.
--   * CHECK constraints pin the crypto shape (12-byte IV -> 16 base64 chars,
--     16-byte GCM tag -> 24 base64 chars, base64 alphabet only) and keep the
--     lifecycle status consistent with its verified/activated/retired stamps.
--   * `oauth_states.config_id` is nullable and references the config version an
--     in-flight OAuth attempt started with; ON DELETE SET NULL means removing a
--     version can never strand or silently re-bind a pending attempt. Existing
--     rows stay valid with `config_id IS NULL` (the pre-#113 behaviour).
--
-- No rollback statement: drizzle-orm's better-sqlite3 migrator applies each file
-- inside a transaction, so a failure leaves the database at 0009 intact.

CREATE TABLE `wechat_oauth_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`account_type` text NOT NULL,
	`app_secret_ciphertext` text NOT NULL,
	`app_secret_iv` text NOT NULL,
	`app_secret_tag` text NOT NULL,
	`key_id` text NOT NULL,
	`status` text NOT NULL,
	`last_error_code` text,
	`verified_at` integer,
	`activated_at` integer,
	`retired_at` integer,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "wechat_oauth_configs_account_type_check" CHECK("wechat_oauth_configs"."account_type" IN ('test', 'official')),
	CONSTRAINT "wechat_oauth_configs_status_check" CHECK("wechat_oauth_configs"."status" IN ('draft', 'verified', 'failed', 'active', 'retired')),
	CONSTRAINT "wechat_oauth_configs_app_id_check" CHECK(length("wechat_oauth_configs"."app_id") BETWEEN 6 AND 64
        AND "wechat_oauth_configs"."app_id" NOT GLOB '*[^A-Za-z0-9]*'),
	CONSTRAINT "wechat_oauth_configs_iv_check" CHECK(length("wechat_oauth_configs"."app_secret_iv") = 16
        AND "wechat_oauth_configs"."app_secret_iv" NOT GLOB '*[^A-Za-z0-9+/=]*'),
	CONSTRAINT "wechat_oauth_configs_tag_check" CHECK(length("wechat_oauth_configs"."app_secret_tag") = 24
        AND "wechat_oauth_configs"."app_secret_tag" NOT GLOB '*[^A-Za-z0-9+/=]*'),
	CONSTRAINT "wechat_oauth_configs_ciphertext_check" CHECK(length("wechat_oauth_configs"."app_secret_ciphertext") > 0
        AND "wechat_oauth_configs"."app_secret_ciphertext" NOT GLOB '*[^A-Za-z0-9+/=]*'),
	CONSTRAINT "wechat_oauth_configs_key_id_check" CHECK(length("wechat_oauth_configs"."key_id") BETWEEN 1 AND 32
        AND "wechat_oauth_configs"."key_id" NOT GLOB '*[^A-Za-z0-9._-]*'),
	CONSTRAINT "wechat_oauth_configs_lifecycle_check" CHECK(("wechat_oauth_configs"."status" = 'active'
          AND "wechat_oauth_configs"."verified_at" IS NOT NULL
          AND "wechat_oauth_configs"."activated_at" IS NOT NULL
          AND "wechat_oauth_configs"."retired_at" IS NULL)
        OR ("wechat_oauth_configs"."status" = 'retired'
          AND "wechat_oauth_configs"."retired_at" IS NOT NULL)
        OR ("wechat_oauth_configs"."status" = 'verified'
          AND "wechat_oauth_configs"."verified_at" IS NOT NULL
          AND "wechat_oauth_configs"."activated_at" IS NULL
          AND "wechat_oauth_configs"."retired_at" IS NULL)
        OR ("wechat_oauth_configs"."status" IN ('draft', 'failed')
          AND "wechat_oauth_configs"."verified_at" IS NULL
          AND "wechat_oauth_configs"."activated_at" IS NULL
          AND "wechat_oauth_configs"."retired_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wechat_oauth_configs_active_uq` ON `wechat_oauth_configs` (`status`) WHERE "wechat_oauth_configs"."status" = 'active';--> statement-breakpoint
CREATE INDEX `wechat_oauth_configs_status_created_idx` ON `wechat_oauth_configs` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `wechat_oauth_configs_created_idx` ON `wechat_oauth_configs` (`created_at`);--> statement-breakpoint
-- SQLite cannot add a foreign-key ACTION to an existing table, but a newly
-- added nullable column may declare one. The ON DELETE SET NULL action is part
-- of the acceptance contract, so it is written explicitly here.
ALTER TABLE `oauth_states` ADD `config_id` text REFERENCES wechat_oauth_configs(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `oauth_state_config_idx` ON `oauth_states` (`config_id`);