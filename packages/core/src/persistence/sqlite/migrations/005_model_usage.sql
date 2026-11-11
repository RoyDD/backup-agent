CREATE TABLE IF NOT EXISTS model_usage (
  id TEXT PRIMARY KEY,
  ticket_id TEXT,
  task TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_model_usage_created ON model_usage(created_at);
CREATE INDEX IF NOT EXISTS idx_model_usage_ticket ON model_usage(ticket_id);
