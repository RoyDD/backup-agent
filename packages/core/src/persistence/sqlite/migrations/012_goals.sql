-- Goal, step, attempt and memory rows.
--
-- This schema grants no authority. It records what the agent decided and what
-- the deterministic core observed; it does not authorise anything. Approvals
-- stay in `approvals` (append-only, four-eyes), leases and fencing stay in
-- `leases`/`lease_fences`. A row here saying `state = 'ready'` is a claim about
-- history, never a permission to run: the runner re-reads the approval and the
-- live lease before any destructive argv is built.
--
-- `action_json` columns are written already redacted by `redactAction()`, so a
-- DSN password never lands in a table that reporting surfaces read.
--
-- `goal_steps` and `step_attempts` cascade from their parents so a goal can be
-- removed as one unit; nothing in the product deletes them implicitly.
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  intent TEXT NOT NULL,
  state TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goals_state ON goals(state, created_at);
CREATE INDEX IF NOT EXISTS idx_goals_target ON goals(target_id, created_at);

CREATE TABLE IF NOT EXISTS goal_steps (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  intent TEXT NOT NULL,
  action_json TEXT NOT NULL,
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  plan_id TEXT,
  approved_by TEXT,
  approved_at TEXT,
  last_error_class TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_goal_steps_ordinal ON goal_steps(goal_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_goal_steps_state ON goal_steps(goal_id, state);

CREATE TABLE IF NOT EXISTS step_attempts (
  id TEXT PRIMARY KEY,
  step_id TEXT NOT NULL REFERENCES goal_steps(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  plan_id TEXT,
  state TEXT NOT NULL,
  exit_code INTEGER,
  error_class TEXT,
  signature TEXT,
  action_json TEXT NOT NULL,
  diagnosis_json TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_step_attempts_number ON step_attempts(step_id, attempt);
CREATE INDEX IF NOT EXISTS idx_step_attempts_signature ON step_attempts(signature, started_at);

CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  goal_id TEXT,
  step_id TEXT,
  kind TEXT NOT NULL,
  signature TEXT NOT NULL,
  action_json TEXT NOT NULL,
  outcome_json TEXT NOT NULL,
  error_class TEXT,
  success INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_target_signature ON memory_entries(target_id, signature, created_at);
CREATE INDEX IF NOT EXISTS idx_memory_created ON memory_entries(created_at);
