CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  config_digest TEXT NOT NULL,
  approver TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_unique
  ON approvals(target_id, config_digest, approver, decision);
CREATE INDEX IF NOT EXISTS idx_approvals_subject
  ON approvals(target_id, config_digest, created_at);
