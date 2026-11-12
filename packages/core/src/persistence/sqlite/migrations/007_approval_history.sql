-- Approvals become an append-only decision log.
--
-- 006 allowed only one row per (target, digest, approver, decision) and updated
-- it in place, which erased the history needed to resolve "latest decision
-- wins". Dropping the unique index lets every decision append; readers resolve
-- the latest decision per approver by (created_at, insertion order).
DROP INDEX IF EXISTS idx_approvals_unique;

CREATE INDEX IF NOT EXISTS idx_approvals_history
  ON approvals(target_id, config_digest, approver, created_at);
