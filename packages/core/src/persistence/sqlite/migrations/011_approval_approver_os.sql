-- `approver` is a self-reported human label: `--approver <any string>` lets one
-- operator submit two "different" approvals. Record the environment-derived OS
-- identity alongside it so four-eyes counts distinct principals, not labels.
-- The column is nullable: rows written before this migration keep working and
-- fall back to the label for distinctness.
ALTER TABLE approvals ADD COLUMN approver_os TEXT;
