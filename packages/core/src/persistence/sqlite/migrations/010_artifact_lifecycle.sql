-- Artifacts are catalog rows, not bytes.
--
-- Retention used to DELETE artifact rows, which silently lost the only record of
-- what was produced and where. This migration makes artifact removal a lifecycle
-- transition instead: `lifecycle_state` is 'live' until a tombstone marks the row
-- as no longer eligible for GFS roots, RPO, metrics or capacity. The row, its
-- path, its checksum and its lineage edges stay readable for trace and audit.
--
-- Nothing here deletes data on disk. No StoragePort exists yet, so physical
-- reclamation of managed paths (and pruning of provider-owned repositories) is
-- still an operator/provider action, not a CLI side effect.
ALTER TABLE artifacts ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'live';
ALTER TABLE artifacts ADD COLUMN tombstoned_at TEXT;

CREATE INDEX IF NOT EXISTS idx_artifacts_lifecycle
  ON artifacts(target_id, lifecycle_state, created_at);
