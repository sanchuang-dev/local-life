-- 0025 LL-PUR-006: Three immutable, non-cash coupons per rewarded team.
-- Grants are the durable budget-reservation ledger; SQLite BEGIN IMMEDIATE
-- serializes the budget check with the grant insert across processes.
CREATE TABLE `coupon_team_grants` (
  `id` text PRIMARY KEY NOT NULL,
  `activity_id` text NOT NULL REFERENCES `activities`(`id`) ON DELETE RESTRICT,
  `team_id` text NOT NULL REFERENCES `activity_teams`(`id`) ON DELETE RESTRICT,
  `rule_version_id` text NOT NULL REFERENCES `activity_rule_versions`(`id`) ON DELETE RESTRICT,
  `face_value_cents` integer NOT NULL CHECK (`face_value_cents` > 0),
  `total_value_cents` integer NOT NULL CHECK (`total_value_cents` = `face_value_cents` * 3),
  `granted_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `coupon_team_grants_activity_team_uq` ON `coupon_team_grants`(`activity_id`,`team_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `coupon_team_grants_team_uq` ON `coupon_team_grants`(`team_id`);--> statement-breakpoint
CREATE INDEX `coupon_team_grants_activity_idx` ON `coupon_team_grants`(`activity_id`);--> statement-breakpoint
CREATE TABLE `coupon_issues` (
  `id` text PRIMARY KEY NOT NULL,
  `grant_id` text NOT NULL REFERENCES `coupon_team_grants`(`id`) ON DELETE RESTRICT,
  `activity_id` text NOT NULL REFERENCES `activities`(`id`) ON DELETE RESTRICT,
  `team_id` text NOT NULL REFERENCES `activity_teams`(`id`) ON DELETE RESTRICT,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE RESTRICT,
  `seat_no` integer NOT NULL CHECK (`seat_no` BETWEEN 1 AND 3),
  `face_value_cents` integer NOT NULL CHECK (`face_value_cents` > 0),
  `status` text NOT NULL CHECK (`status` IN ('available','reserved','redeemed','void')),
  `issued_at` integer NOT NULL,
  `expires_at` integer NOT NULL CHECK (`expires_at` > `issued_at`),
  `reserved_order_id` text REFERENCES `local_orders`(`id`) ON DELETE RESTRICT,
  `reserved_at` integer,
  `redeemed_at` integer,
  `voided_at` integer,
  `updated_at` integer NOT NULL,
  CONSTRAINT `coupon_issues_reserved_fields` CHECK (
    (`status`='available' AND `reserved_order_id` IS NULL AND `reserved_at` IS NULL AND `redeemed_at` IS NULL)
    OR (`status`='reserved' AND `reserved_order_id` IS NOT NULL AND `reserved_at` IS NOT NULL AND `redeemed_at` IS NULL)
    OR (`status`='redeemed' AND `reserved_order_id` IS NOT NULL AND `reserved_at` IS NOT NULL AND `redeemed_at` IS NOT NULL)
    OR (`status`='void' AND `voided_at` IS NOT NULL)
  )
);--> statement-breakpoint
CREATE UNIQUE INDEX `coupon_issues_grant_user_uq` ON `coupon_issues`(`grant_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `coupon_issues_grant_seat_uq` ON `coupon_issues`(`grant_id`,`seat_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `coupon_issues_order_uq` ON `coupon_issues`(`reserved_order_id`);--> statement-breakpoint
CREATE INDEX `coupon_issues_user_issued_idx` ON `coupon_issues`(`user_id`,`issued_at`);--> statement-breakpoint
CREATE INDEX `coupon_issues_activity_status_idx` ON `coupon_issues`(`activity_id`,`status`);--> statement-breakpoint
CREATE TABLE `coupon_issue_events` (
  `id` text PRIMARY KEY NOT NULL,
  `coupon_id` text NOT NULL REFERENCES `coupon_issues`(`id`) ON DELETE RESTRICT,
  `kind` text NOT NULL CHECK (`kind` IN ('issued','reserved','redeemed','released','voided')),
  `order_id` text REFERENCES `local_orders`(`id`) ON DELETE RESTRICT,
  `created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `coupon_issue_events_coupon_created_idx` ON `coupon_issue_events`(`coupon_id`,`created_at`);--> statement-breakpoint
-- Defensive SQL rule: even a second writer cannot book another team if exhausted.
CREATE TRIGGER `coupon_team_grants_validate` BEFORE INSERT ON `coupon_team_grants`
BEGIN
  SELECT RAISE(ABORT,'coupon grant requires a locked matching team')
  WHERE NOT EXISTS (SELECT 1 FROM `activity_teams` t WHERE t.id=NEW.team_id AND t.activity_id=NEW.activity_id AND t.status='locked');
  SELECT RAISE(ABORT,'coupon grant must use frozen purchase plan')
  WHERE NOT EXISTS (
    SELECT 1 FROM `activities` a
    JOIN `activity_rule_versions` v ON v.id=NEW.rule_version_id AND v.activity_id=a.id
    WHERE a.id=NEW.activity_id AND a.current_rule_version_id=NEW.rule_version_id
      AND a.status <> 'draft'
      AND json_extract(v.snapshot_json,'$.purchaseRewardPlan.couponFaceValueCents')=NEW.face_value_cents
      AND json_extract(v.snapshot_json,'$.purchaseRewardPlan.maxRewardedTeams') >= 1
  );
  SELECT RAISE(ABORT,'coupon reward budget exhausted')
  WHERE (SELECT COUNT(*) FROM `coupon_team_grants` WHERE activity_id=NEW.activity_id)
    >= (SELECT json_extract(v.snapshot_json,'$.purchaseRewardPlan.maxRewardedTeams')
        FROM `activity_rule_versions` v WHERE v.id=NEW.rule_version_id);
END;--> statement-breakpoint
CREATE TRIGGER `coupon_team_grants_no_update` BEFORE UPDATE ON `coupon_team_grants`
BEGIN SELECT RAISE(ABORT,'coupon grants are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `coupon_team_grants_no_delete` BEFORE DELETE ON `coupon_team_grants`
BEGIN SELECT RAISE(ABORT,'coupon grants are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `coupon_issues_validate` BEFORE INSERT ON `coupon_issues`
BEGIN
  SELECT RAISE(ABORT,'coupon issue not from matching grant or team member')
  WHERE NOT EXISTS (
    SELECT 1 FROM `coupon_team_grants` g
    JOIN `activity_participations` p ON p.team_id=g.team_id AND p.activity_id=g.activity_id
    WHERE g.id=NEW.grant_id AND g.activity_id=NEW.activity_id AND g.team_id=NEW.team_id
      AND g.face_value_cents=NEW.face_value_cents
      AND p.user_id=NEW.user_id AND p.seat_no=NEW.seat_no
  );
END;--> statement-breakpoint
CREATE TRIGGER `coupon_issues_identity_immutable` BEFORE UPDATE ON `coupon_issues`
WHEN OLD.id IS NOT NEW.id OR OLD.grant_id IS NOT NEW.grant_id
  OR OLD.activity_id IS NOT NEW.activity_id OR OLD.team_id IS NOT NEW.team_id
  OR OLD.user_id IS NOT NEW.user_id OR OLD.seat_no IS NOT NEW.seat_no
  OR OLD.face_value_cents IS NOT NEW.face_value_cents
  OR OLD.issued_at IS NOT NEW.issued_at OR OLD.expires_at IS NOT NEW.expires_at
BEGIN SELECT RAISE(ABORT,'coupon identity and face value are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `coupon_issues_no_delete` BEFORE DELETE ON `coupon_issues`
BEGIN SELECT RAISE(ABORT,'coupon issues cannot be deleted'); END;--> statement-breakpoint
CREATE TRIGGER `coupon_issue_events_no_update` BEFORE UPDATE ON `coupon_issue_events`
BEGIN SELECT RAISE(ABORT,'coupon events are append only'); END;--> statement-breakpoint
CREATE TRIGGER `coupon_issue_events_no_delete` BEFORE DELETE ON `coupon_issue_events`
BEGIN SELECT RAISE(ABORT,'coupon events are append only'); END;
