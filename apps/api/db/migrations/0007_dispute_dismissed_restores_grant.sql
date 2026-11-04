-- LL-MVP-006 / t17 (B2): dismissing a dispute must restore the grant.
--
-- A `dismissed` decision means "the prize was handed over correctly". Before
-- this migration the grant stayed flagged `disputed` forever, because the 0006
-- state machine had no `disputed -> redeemed` edge. The consequences were real:
--   * `stock.redeemed_quantity` and `counts.grantsRedeemed` differed by one for
--     good, so end-of-activity reconciliation had two numbers and no rule for
--     which to settle on;
--   * the admin surface rendered no actions (no open dispute) while the resident
--     surface kept saying "still disputed, ask a staff member on site" - pointing
--     the resident at someone with no tool to help;
--   * all five recovery paths (revoke / reopen / reverse / redeem / re-claim)
--     returned 409, and three triggers forbade fixing it in SQL.
--
-- This migration does TWO things, and both are required:
--   1. replace the status-transition trigger so `disputed -> redeemed` is legal
--      (stops NEW rows from getting stuck);
--   2. repair the rows that are ALREADY stuck (stops EXISTING rows from staying
--      stuck forever - no application code would ever revisit them).
-- Step 2 is why the ordering below matters: the repair UPDATE runs *after* the
-- trigger has been replaced, otherwise the very UPDATE meant to unstick the data
-- would be aborted by the old trigger.
--
-- Nothing else about the state machine changes. `redeemed -> disputed` (opening
-- a dispute) and `disputed -> reversed` (upholding one) are untouched, so the
-- reversal path keeps its existing semantics.
--
-- Rollback:
--   1. UPDATE back is NOT possible automatically (the original `disputed` flag of
--      a repaired row is no longer recoverable from the grant row alone) - use
--      the dispute thread to identify them;
--   2. DROP TRIGGER IF EXISTS `activity_reward_grants_status_transition`;
--      then re-create the 0006 definition from `0006_wakeful_wallow.sql`.

-- ---------------------------------------------------------------------------
-- Step 1: replace the trigger (DROP + CREATE, never CREATE IF NOT EXISTS - the
-- latter would silently keep the 0006 definition and leave `disputed -> redeemed`
-- illegal).
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS `activity_reward_grants_status_transition`;--> statement-breakpoint
CREATE TRIGGER `activity_reward_grants_status_transition`
BEFORE UPDATE OF `status` ON `activity_reward_grants`
WHEN NOT (
	OLD.`status` = NEW.`status`
	OR (OLD.`status` = 'granted' AND NEW.`status` IN ('redeemed', 'revoked', 'expired'))
	OR (OLD.`status` = 'redeemed' AND NEW.`status` = 'disputed')
	-- t17: dismissing a dispute restores the grant. Without this edge a grant is
	-- stranded in `disputed` forever and the stock ledger can never reconcile.
	OR (OLD.`status` = 'disputed' AND NEW.`status` IN ('reversed', 'redeemed'))
)
BEGIN
	SELECT RAISE(ABORT, 'activity_reward_grants status transition is not allowed');
END;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Step 2: repair rows stranded by the old behaviour.
--
-- A grant is restored ONLY when its LATEST dispute-thread entry is `dismissed`,
-- i.e. the thread was closed as "no problem". If the thread ends with `opened`
-- (still under review) or `reversed` (upheld), the grant keeps its current
-- status - `disputed` for the former, and the latter is not `disputed` anyway.
--
-- "Latest" is decided exactly like `selectOpenDisputeId` does it:
--   ORDER BY created_at DESC, rowid DESC
-- so the SQL and the service layer agree on which entry is authoritative.
-- ---------------------------------------------------------------------------
UPDATE `activity_reward_grants`
SET `status` = 'redeemed'
WHERE `activity_reward_grants`.`status` = 'disputed'
	AND (
		SELECT d.`decision`
		FROM `activity_reward_disputes` d
		WHERE d.`grant_id` = `activity_reward_grants`.`id`
		ORDER BY d.`created_at` DESC, d.`rowid` DESC
		LIMIT 1
	) = 'dismissed';
