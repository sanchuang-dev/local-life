-- LL-ACT-VIS-001 (#309): presentation-only activity visual configuration.
--
-- Additive and non-destructive by design:
--   * `theme_key` is NOT NULL with the historical green default, so every
--     existing activity keeps the pre-#309 look without a data rewrite;
--   * the four artwork/copy columns stay NULL, which lets the H5 keep its
--     existing silver-neighbourhood artwork fallback;
--   * there is deliberately no UPDATE: this migration must never invent promo
--     copy or a poster for an activity that never configured one.
ALTER TABLE `activities` ADD `theme_key` text DEFAULT 'community-green' NOT NULL;--> statement-breakpoint
ALTER TABLE `activities` ADD `hero_image_url` text;--> statement-breakpoint
ALTER TABLE `activities` ADD `promo_title` text;--> statement-breakpoint
ALTER TABLE `activities` ADD `promo_subtitle` text;--> statement-breakpoint
ALTER TABLE `activities` ADD `poster_image_url` text;
