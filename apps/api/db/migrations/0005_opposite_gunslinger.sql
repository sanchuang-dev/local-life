-- P1-1: order/refund audit events move from a state-combination unique key to a
-- per-order monotonic revision. Existing rows are upgraded in place (no table
-- rebuild, no history loss): every row gets a deterministic sequence ordered by
-- (created_at, id) inside its order, then the old unique key is dropped and the
-- new (order_id, sequence) unique key is created.
--
-- The append-only UPDATE trigger is dropped only inside this migration's
-- transaction so the backfill can run, then recreated verbatim from 0004.
DROP TRIGGER `crmeb_order_events_no_update`;--> statement-breakpoint
DROP INDEX `crmeb_order_events_order_event_uq`;--> statement-breakpoint
ALTER TABLE `crmeb_order_events` ADD `sequence` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `crmeb_order_events`
SET `sequence` = (
	SELECT COUNT(*)
	FROM `crmeb_order_events` AS `earlier`
	WHERE `earlier`.`order_id` = `crmeb_order_events`.`order_id`
		AND (
			`earlier`.`created_at` < `crmeb_order_events`.`created_at`
			OR (
				`earlier`.`created_at` = `crmeb_order_events`.`created_at`
				AND `earlier`.`id` <= `crmeb_order_events`.`id`
			)
		)
);--> statement-breakpoint
CREATE TRIGGER `crmeb_order_events_no_update`
BEFORE UPDATE ON `crmeb_order_events`
BEGIN
	SELECT RAISE(ABORT, 'crmeb_order_events rows are append-only');
END;--> statement-breakpoint
CREATE UNIQUE INDEX `crmeb_order_events_order_sequence_uq` ON `crmeb_order_events` (`order_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `crmeb_order_events_order_event_idx` ON `crmeb_order_events` (`order_id`,`event_key`);--> statement-breakpoint
-- SQLite cannot add a NOT NULL constraint without rebuild, so the default used
-- only for the migration backfill is rejected for every future insert instead.
CREATE TRIGGER `crmeb_order_events_sequence_guard`
BEFORE INSERT ON `crmeb_order_events`
WHEN NEW.`sequence` IS NULL OR NEW.`sequence` < 1
BEGIN
	SELECT RAISE(ABORT, 'crmeb_order_events.sequence must be a positive integer');
END;
