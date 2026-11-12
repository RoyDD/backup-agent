-- Attempts remember the target whose lease they were running under.
--
-- Before this migration reconcile could only compare `attempts.lease_expires_at`
-- with "now", which stalls a legitimately long run whose heartbeat keeps the
-- lease alive. The target identity lets reconciliation read the *live* lease
-- row instead. The column is nullable so existing control databases upgrade in
-- place; rows written by earlier releases are backfilled from their plan, which
-- always carries the provider-specific target identity.
ALTER TABLE attempts ADD COLUMN target_id TEXT;

UPDATE attempts
   SET target_id = (
         SELECT json_extract(plans.payload_json, '$.targetId')
           FROM plans
          WHERE plans.id = attempts.plan_id
       )
 WHERE target_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_attempts_target ON attempts(target_id, state);
