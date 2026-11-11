CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mandates (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  allowed_risk TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  mandate_id TEXT NOT NULL REFERENCES mandates(id) ON DELETE RESTRICT,
  state TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  fingerprint_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  owner TEXT NOT NULL,
  lease_token INTEGER NOT NULL,
  lease_expires_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  exit_code INTEGER
);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  dispatched_at TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS leases (
  target_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  token INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lease_fences (
  target_id TEXT PRIMARY KEY,
  counter INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lineage_edges (
  from_kind TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_kind TEXT NOT NULL,
  to_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tickets_state ON tickets(state);
CREATE INDEX IF NOT EXISTS idx_mandates_ticket ON mandates(ticket_id);
CREATE INDEX IF NOT EXISTS idx_plans_ticket ON plans(ticket_id);
CREATE INDEX IF NOT EXISTS idx_attempts_state_lease ON attempts(state, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_outbox_status_available ON outbox(status, available_at);
CREATE INDEX IF NOT EXISTS idx_lineage_from ON lineage_edges(from_kind, from_id);
CREATE INDEX IF NOT EXISTS idx_lineage_to ON lineage_edges(to_kind, to_id);
