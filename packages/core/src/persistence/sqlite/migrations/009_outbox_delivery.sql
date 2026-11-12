-- Monotonic per-record delivery token for the transactional outbox.
--
-- A consumer claims a record (lease + token bump), performs the side effect
-- outside any transaction, then confirms with the token. A record reclaimed by
-- another consumer has a higher token, so the slow consumer's confirmation
-- loses instead of overwriting the new claim. Payloads stay immutable: only
-- status/lease/attempt bookkeeping columns are ever updated.
ALTER TABLE outbox ADD COLUMN delivery_token INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_outbox_status_lease
  ON outbox(status, lease_expires_at);
