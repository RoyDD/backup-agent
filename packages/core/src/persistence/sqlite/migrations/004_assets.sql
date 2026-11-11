CREATE TABLE IF NOT EXISTS assets (
  target_id TEXT PRIMARY KEY,
  engine TEXT NOT NULL,
  environment TEXT NOT NULL,
  owner TEXT NOT NULL,
  criticality TEXT NOT NULL,
  data_classification TEXT NOT NULL,
  rpo_minutes INTEGER NOT NULL,
  rto_minutes INTEGER NOT NULL,
  maintenance_window_json TEXT,
  protected INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
