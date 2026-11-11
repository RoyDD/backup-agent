CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  plan_id TEXT,
  target_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  parent_id TEXT,
  path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  checksum TEXT,
  verified_level TEXT,
  verified_at TEXT,
  protected INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artifacts_target ON artifacts(target_id, created_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_provider ON artifacts(provider, created_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_parent ON artifacts(parent_id);
